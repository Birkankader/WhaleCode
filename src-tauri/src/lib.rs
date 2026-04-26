mod agents;
mod detection;
mod editor;
mod gitignore;
mod ipc;
mod orchestration;
mod repo;
mod safety;
mod settings;
mod storage;
mod worktree;
mod worktree_actions;

use std::sync::Arc;

use detection::Detector;
use ipc::commands;
use orchestration::{DefaultAgentRegistry, Orchestrator, TauriEventSink};
use settings::SettingsStore;
use storage::{migrations, Storage};
use tauri::Manager;

/// DB filename under `$app_config_dir`. Shared by `tauri-plugin-sql` (frontend
/// access) and the Rust-side `Storage` (orchestrator, step 8). Both pools open
/// the same file; migrations are idempotent so whichever runs first wins.
const DB_FILENAME: &str = "whalecode.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(&format!("sqlite:{DB_FILENAME}"), migrations::all())
                .build(),
        )
        .setup(|app| {
            // Settings: load once, share via Arc so Detector can hold a clone
            // while commands borrow through Tauri's `State<Arc<...>>`.
            let settings_path = settings::resolve_path(app.handle())?;
            let settings = Arc::new(SettingsStore::load_at(settings_path));
            app.manage(settings.clone());

            // Detector: stateless apart from its settings handle. Arc so the
            // registry and `detect_agents` command share the same probe.
            let detector = Arc::new(Detector::new(settings.clone()));
            app.manage(detector.clone());

            // Storage: Rust-side pool against the same DB file plugin-sql uses.
            let db_path = app
                .path()
                .app_config_dir()
                .map(|d| d.join(DB_FILENAME))?;
            let storage = Arc::new(tauri::async_runtime::block_on(Storage::open(&db_path))?);
            app.manage(storage.clone());

            // Orchestrator: single owner of every in-flight run. Constructed
            // once here and shared to commands via `State<Arc<Orchestrator>>`.
            let event_sink = Arc::new(TauriEventSink::new(app.handle().clone()));
            let registry = Arc::new(DefaultAgentRegistry::new(detector));
            let orchestrator =
                Arc::new(Orchestrator::new(settings, storage, event_sink, registry));

            // Sweep stale `Running`/`Merging` rows and orphan worktrees left
            // by a previous crash. Must run before the frontend attaches a
            // RunSubscription — frontend window isn't shown until setup
            // returns, so block_on is the simplest way to honour that
            // contract. Recovery is bounded (O(active runs) DB + fs ops);
            // typically zero work.
            let recovered = tauri::async_runtime::block_on(orchestrator.recover_active_runs());
            if recovered > 0 {
                eprintln!("[orchestrator] recovered {recovered} active run(s) from prior session");
            }

            app.manage(orchestrator);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::submit_task,
            commands::approve_subtasks,
            commands::reject_run,
            commands::apply_run,
            commands::discard_run,
            commands::cancel_run,
            // Phase 5 Step 1: per-worker stop. Distinct from cancel_run
            // — this stops exactly one subtask and leaves the rest of
            // the run running. Bypasses the retry ladder entirely.
            commands::cancel_subtask,
            // Phase 5 Step 2: base-branch dirty helper. stash_and_retry_apply
            // composes `git stash push -u` + the existing apply oneshot;
            // pop_stash is user-initiated — no auto-pop after Apply because
            // the stashed changes may conflict with the just-applied diffs
            // and the user should see the state before the pop writes over it.
            commands::stash_and_retry_apply,
            commands::pop_stash,
            // Phase 5 Step 3: merge conflict resolver. retry_apply is
            // a semantic alias for apply_run — the lifecycle already
            // re-installs the apply oneshot on MergeConflict, so
            // retry just re-enters the merge attempt with whatever
            // resolutions the user landed externally.
            commands::retry_apply,
            // Phase 5 Step 4: interactive agent Q&A. Universal
            // restart-with-appended-prompt path (Step 0 diagnostic
            // confirmed no adapter-specific structured signal). Skip
            // is the false-positive escape hatch.
            commands::answer_subtask_question,
            commands::skip_subtask_question,
            // Phase 6 Step 4: mid-execution hint injection. Reuses
            // Phase 5 cancel + restart-with-extra mechanism; hint
            // restart bypasses Layer 1 retry budget.
            commands::hint_subtask,
            commands::update_subtask,
            commands::add_subtask,
            commands::remove_subtask,
            commands::detect_agents,
            commands::set_master_agent,
            commands::get_settings,
            commands::set_settings,
            commands::consume_recovery_report,
            commands::consume_migration_notices,
            commands::manual_fix_subtask,
            commands::mark_subtask_fixed,
            commands::skip_subtask,
            commands::try_replan_again,
            // Phase 4 Step 4: worktree inspection affordances. Three
            // new handlers; all gate on the subtask being in an
            // inspectable state (done / failed / human-escalation /
            // cancelled) so running workers can't be poked at mid-
            // write.
            commands::get_subtask_worktree_path,
            commands::reveal_worktree,
            commands::open_terminal_at,
            repo::pick_repo,
            repo::validate_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
