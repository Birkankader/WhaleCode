# WhaleCode — Proje Dokümantasyonu

## Vizyon

WhaleCode, birden fazla AI kodlama ajanını (Claude Code, Gemini CLI, Codex CLI) aynı anda, aynı proje üzerinde paralel çalıştıran bir **masaüstü orkestrasyon uygulamasıdır**. Bir LLM framework'ü değil — gerçek CLI süreçlerini yöneten bir **süreç orkestratörüdür**.

Temel felsefe: *Tek bir AI ajanı bir görevi 10 dakikada yaparsa, üç ajan paralel çalışarak karmaşık bir görevi daha hızlı, daha güvenli ve daha kaliteli yapabilir.*

WhaleCode bunu mümkün kılan üç şeyi çözer:
1. **Görev ayrıştırma** — Karmaşık bir isteği bağımsız alt görevlere böler
2. **İzole paralel çalışma** — Her ajan kendi git worktree'sinde çalışır, birbirini bozmaz
3. **Entegre inceleme** — Tüm sonuçları birleştirip kullanıcıya sunar

---

## Ne Yapıyor?

### Üç Fazlı Orkestrasyon Döngüsü

```
Kullanıcı Promptu
       │
       ▼
┌─────────────────────┐
│  Faz 1: DECOMPOSE   │  Master ajan görevi analiz eder,
│  (Görev Ayrıştırma) │  alt görevlere böler, her birini
│                     │  bir ajana atar, bağımlılıkları belirler
└─────────┬───────────┘
          │ JSON task plan
          ▼
┌─────────────────────┐
│  APPROVAL            │  Kullanıcı alt görev planını görür:
│  (Onay Ekranı)       │  - Ajan atamalarını değiştirebilir
│                      │  - Görev ekleyip çıkarabilir
│                      │  - İptal edebilir
│                      │  - Sıralamayı değiştirebilir
└─────────┬────────────┘
          │ Onay
          ▼
┌─────────────────────┐
│  Faz 2: EXECUTE      │  Her alt görev paralel olarak
│  (Paralel Yürütme)   │  izole git worktree'lerde çalışır.
│                      │  DAG bağımlılık sırası korunur.
│  ┌────┐ ┌────┐       │  Rate limit → retry → fallback
│  │ C  │ │ G  │       │
│  └────┘ └────┘       │
│     ┌────┐           │
│     │ X  │           │  C=Claude, G=Gemini, X=Codex
│     └────┘           │
└─────────┬────────────┘
          │ Worktree diffs
          ▼
┌─────────────────────┐
│  Faz 3: REVIEW       │  İnceleme ajanı tüm worktree
│  (İnceleme & Merge)  │  diff'lerini alır, çakışmaları
│                      │  kontrol eder, özet üretir.
│                      │  Kullanıcı dosya bazında
│                      │  kabul/red yaparak merge eder.
└─────────────────────┘
```

### Temel Özellikler

| Özellik | Açıklama |
|---------|----------|
| **Multi-agent orkestrasyon** | Tek bir promptla birden fazla AI ajanı paralel çalıştırma |
| **Git worktree izolasyonu** | Her ajan kendi worktree'sinde çalışır — dosya çakışması olmaz |
| **DAG bağımlılık yönetimi** | Alt görevler arası bağımlılıklar Kahn algoritmasıyla dalga (wave) bazlı çözülür |
| **Görev onay ekranı** | Decompose sonrası kullanıcı planı inceleyip düzenleyebilir |
| **Akıllı yönlendirme** | Prompt analizine göre en uygun ajanı önerir |
| **Gerçek zamanlı streaming** | NDJSON çıktı akışı, xterm.js terminalde canlı görüntüleme |
| **Diff inceleme** | Worktree bazlı inline diff viewer, dosya seviyesinde kabul/red |
| **Hata toleransı** | Rate limit tespiti → exponential backoff → alternatif ajana fallback |
| **Güvenli credential saklama** | API key'ler macOS Keychain'de, asla CLI argümanı olarak geçirilmez |
| **İptal mekanizması** | Onay veya yürütme sırasında orkestrasyon iptal edilebilir |

---

## Desteklenen Ajanlar

| Ajan | CLI Komutu | Mod | Kullanım Alanı |
|------|-----------|-----|----------------|
| **Claude Code** | `claude` | `--output-format stream-json --verbose` | Karmaşık refactoring, mimari kararlar |
| **Gemini CLI** | `gemini` | `--output-format stream-json --yolo` | Doküman yazma, analiz, test |
| **Codex CLI** | `codex` | `--output-format stream-json --full-auto` | Hızlı kod üretimi, boilerplate |

Her ajan `ToolAdapter` trait'i üzerinden tanımlı. Yeni ajan eklemek trait implementasyonu yazmak kadar basit.

---

## Mimari

### Teknoloji Yığını

| Katman | Teknoloji |
|--------|----------|
| **Backend** | Rust, Tauri v2, Tokio (async runtime), git2, rusqlite, keyring |
| **Frontend** | React 19, TypeScript, Vite, Tailwind CSS 4, Zustand, shadcn/ui |
| **IPC** | tauri-specta (tip-güvenli otomatik TypeScript binding üretimi) |
| **Dağıtım** | DMG (macOS), gelecekte Windows/Linux desteği planlanıyor |

### Backend Modülleri (Rust — ~16.400 satır)

```
src-tauri/src/
├── adapters/           # ToolAdapter trait + ajan implementasyonları
│   ├── mod.rs          #   ToolCommand, RateLimitInfo, Question, RetryPolicy
│   ├── claude.rs       #   Claude Code: NDJSON parse, komut yapısı, soru tespiti
│   ├── gemini.rs       #   Gemini CLI: stream-json parse, rate limit tespiti
│   └── codex.rs        #   Codex CLI: turn-based event parse
│
├── router/             # Orkestrasyon motoru
│   ├── orchestrator.rs #   OrchestrationPlan, SubTaskDef, DecompositionResult
│   ├── dag.rs          #   Kahn algoritması ile topolojik dalga sıralaması
│   ├── retry.rs        #   Exponential backoff, agent fallback mantığı
│   └── mod.rs          #   TaskRouter (keyword-based ajan önerisi)
│
├── commands/           # Tauri IPC komut handler'ları
│   ├── orchestrator.rs #   dispatch_orchestrated_task, approve/cancel_orchestration
│   ├── router.rs       #   dispatch_task, dispatch_task_inner
│   ├── worktree.rs     #   create/merge/cleanup worktree komutları
│   ├── git.rs          #   git status/stage/commit/push/pull
│   └── ...             #   claude/gemini/codex/process/config komutları
│
├── process/            # Süreç yönetimi
│   ├── manager.rs      #   spawn_interactive, kill_and_remove, send_to_process
│   └── signals.rs      #   pgid izolasyonu, graceful_kill (SIGTERM→SIGKILL)
│
├── worktree/           # Git worktree yaşam döngüsü
│   ├── manager.rs      #   WorktreeManager: create_for_task, prune, cleanup
│   ├── conflict.rs     #   auto_commit_worktree
│   ├── diff.rs         #   generate_worktree_diff (branch vs default)
│   └── models.rs       #   WorktreeEntry, WorktreeDiffReport
│
├── context/            # Proje bağlam motoru (SQLite)
│   ├── store.rs        #   ContextStore: görev sonuçları, ajan istatistikleri
│   ├── queries.rs      #   record_task_outcome, query_recent_changes
│   └── migrations.rs   #   Şema versiyonlama
│
├── credentials/        # macOS Keychain entegrasyonu
│   ├── keychain.rs     #   Claude API key (keyring crate, apple-native)
│   ├── gemini_keychain.rs
│   └── codex_keychain.rs
│
├── config.rs           # Uygulama konfigürasyonu (timeout'lar, retry limitleri)
├── state.rs            # AppState: processes, orchestration_plans, signals
└── lib.rs              # Tauri uygulaması kurulumu, PATH genişletme
```

### Frontend Modülleri (React/TypeScript — ~17.000 satır)

```
src/
├── stores/                     # Zustand state yönetimi
│   ├── taskStore.ts            #   Orkestrasyon durumu, görev listesi, faz takibi
│   ├── uiStore.ts              #   Aktif görünüm, ayarlar, panel durumları
│   └── notificationStore.ts    #   Bildirim merkezi
│
├── hooks/
│   ├── orchestration/
│   │   ├── useOrchestratedDispatch.ts  # Tauri IPC → orkestrasyon başlatma
│   │   └── handleOrchEvent.ts          # @@orch:: event handler (30+ event tipi)
│   ├── useOrchestrationLaunch.ts       # Prompt + config → dispatch tetikleme
│   └── useTaskDispatch.ts              # Tekli görev dispatch (non-orchestrated)
│
├── components/
│   ├── views/
│   │   ├── WorkingView.tsx       # Kanban görev panosu (pending → running → done)
│   │   ├── TaskApprovalView.tsx  # Decompose sonrası onay ekranı
│   │   ├── CodeReviewView.tsx    # Worktree diff inceleme
│   │   ├── TaskDetail.tsx        # Tekil görev detay sayfası
│   │   ├── GitView.tsx           # Git durumu ve operasyonları
│   │   ├── CodeView.tsx          # Proje dosya tarayıcı
│   │   └── UsageView.tsx         # Token/maliyet takibi
│   │
│   ├── orchestration/
│   │   ├── StagePipeline.tsx     # Decompose → Approve → Execute → Review → Done
│   │   ├── DecompositionErrorCard.tsx  # Humanized hata kartı
│   │   ├── RateLimitDialog.tsx   # Rate limit uyarısı + ajan yeniden atama
│   │   └── TaskApproval.tsx      # Alt bileşen (eski versiyon)
│   │
│   ├── review/
│   │   ├── DiffReview.tsx        # Worktree bazlı diff kartları
│   │   └── FileDiffView.tsx      # Dosya bazlı unified diff görüntüleme
│   │
│   └── layout/
│       ├── AppShell.tsx          # Ana layout: sidebar + content + panels
│       ├── Sidebar.tsx           # Navigasyon + session geçmişi
│       └── QuestionBanner.tsx    # Ajan soru banner'ı
│
└── lib/
    ├── agents.ts           # Ajan renkleri, label'ları, ikon harfleri
    ├── humanizeError.ts    # 21 hata pattern'i → kullanıcı dostu mesaj
    └── theme.ts            # Tasarım token'ları (C.accent, C.surface, vb.)
```

### Veri Akışı

```
Kullanıcı Input (React)
       │
       ▼
useOrchestrationLaunch (hook)
       │ commands.dispatchOrchestratedTask()
       ▼
Tauri IPC (tauri-specta type-safe binding)
       │
       ▼
dispatch_orchestrated_task (Rust)
       │
       ├── Faz 1: adapter.build_command() → spawn_interactive()
       │          wait_for_turn_complete() → parse_decomposition_from_output()
       │          5 fallback JSON parsing stratejisi
       │
       ├── Approval: watch channel ile bekle ← approve_orchestration()
       │
       ├── Faz 2: WorktreeManager::create_for_task()
       │          JoinSet::spawn(dispatch_and_await_worker())
       │          retry + fallback + rate limit detection
       │
       ├── Faz 2.5: auto_commit_worktree() → generate_worktree_diff()
       │
       └── Faz 3: build_review_prompt_with_diffs() → spawn review
       │
       ▼
Channel<OutputEvent> → @@orch:: prefixed JSON events
       │
       ▼
handleOrchEvent (TypeScript)
       │ taskStore.setOrchestrationPhase()
       │ taskStore.addTask() / updateTaskStatus()
       ▼
React UI güncellenir (Zustand → useShallow → component render)
```

---

## Mevcut Durum (v0.2.0)

### Tamamlanan

- ✅ Üç fazlı orkestrasyon pipeline'ı (decompose → approve → execute → review)
- ✅ Git worktree izolasyonu (`.whalecode-worktrees/`)
- ✅ DAG bağımlılık yönetimi (Kahn's algorithm, topological waves)
- ✅ Paralel çalışma (JoinSet, per-dispatch-id slot'lar)
- ✅ Rate limit tespiti + exponential backoff + ajan fallback
- ✅ Görev onay ekranı (düzenleme, ekleme, çıkarma, sıralama, iptal)
- ✅ Worktree bazlı diff inceleme + merge kontrolü
- ✅ Hata mesajları humanize edilmiş (21 pattern)
- ✅ macOS Keychain entegrasyonu (keychain şifresi sormaz)
- ✅ Kanban görev panosu (WorkingView)
- ✅ Session geçmişi
- ✅ Auto-approve modu (varsayılan kapalı)
- ✅ DMG dağıtımı (macOS, ad-hoc signing)
- ✅ 199 test (5 suite)
- ✅ 17 requirement validated

### Gelecek Planlar (Deferred Requirements)

| ID | Özellik | Açıklama |
|----|---------|----------|
| R013 | Basit görev modu | Basit promptlar orkestrasyon overhead'i olmadan tek ajanla çalışsın |
| R014 | Harcama limiti | Orkestrasyon başına maksimum token/maliyet sınırı |
| R015 | A/B karşılaştırma | Aynı görevi birden fazla ajana verip sonuçları karşılaştırma |
| R016 | Plugin mimarisi | Yeni ajan adaptörleri core kod değiştirmeden eklenebilsin |
| R017 | Cross-platform | Windows ve Linux desteği |
| R018 | GitHub PR entegrasyonu | Worktree değişikliklerinden direkt PR oluşturma |

---

## Neden WhaleCode?

### Problem

AI kodlama ajanları (Claude Code, Gemini CLI, Codex) tek başlarına güçlüdür. Ama karmaşık görevlerde:

- **Tek ajan darboğaz olur** — büyük refactoring'de context window dolup verim düşer
- **Parallel çalışma tehlikelidir** — iki ajan aynı dosyaya yazarsa git çakışması olur
- **Koordinasyon yoktur** — hangi ajan neyi yapıyor, bağımlılıklar nedir, belirsiz
- **İnceleme zordur** — birden fazla ajanın çıktısını karşılaştırmak manuel iş

### Çözüm

WhaleCode bu sorunları çözer:

1. **Otomatik görev ayrıştırma** — Master ajan karmaşık görevi bağımsız alt görevlere böler
2. **İzole paralel yürütme** — Her ajan kendi git worktree'sinde çalışır, çakışma olmaz
3. **Bağımlılık yönetimi** — DAG ile görevler doğru sırayla, paralel çalıştırılır
4. **Birleşik inceleme** — Tüm değişiklikler tek ekranda, dosya bazlı kabul/red
5. **Hata toleransı** — Rate limit, timeout, crash durumlarında otomatik retry ve fallback

### Fark Yaratan Özellikler

- **LLM framework değil, süreç orkestratörü** — Kendi API çağrısı yapmaz, mevcut CLI araçlarını yönetir
- **Ajan-agnostik** — Claude, Gemini, Codex bugün desteklenir; ToolAdapter trait'i ile herhangi biri eklenebilir
- **Yerel uygulama** — Tauri v2 ile native masaüstü uygulaması, web sunucusu gerektirmez
- **Git-native izolasyon** — Worktree'ler gerçek git mekanizmasıdır, yapay sandbox değil

---

## Nasıl Çalıştırılır?

### Gereksinimler

- macOS 13+ (şu an sadece macOS destekleniyor)
- Node.js 18+
- Rust (stable)
- En az bir CLI ajanı yüklü: `claude`, `gemini`, veya `codex`

### Geliştirme

```bash
npm install
npm run tauri dev
```

### Production Build (DMG)

```bash
npm run tauri build
# Çıktı: src-tauri/target/release/bundle/dmg/WhaleCode_0.2.0_aarch64.dmg
```

### API Key Ayarları

Uygulama içinden Settings → API Keys ekranından yapılır. Key'ler macOS Keychain'de güvenle saklanır.

---

## Metrikler

| Metrik | Değer |
|--------|-------|
| Rust kodu | ~16.400 satır |
| TypeScript/React kodu | ~17.000 satır |
| Test sayısı | 199 (5 suite) |
| Validated requirements | 17 |
| Deferred requirements | 6 |
| DMG boyutu | 7.5 MB |
| Desteklenen ajan sayısı | 3 (Claude, Gemini, Codex) |
| Minimum macOS | 13.0 (Ventura) |
