# Phase 1: Graph foundation

**Goal:** A working demo that renders a mock master-worker orchestration as an execution graph, with all node states and transitions functioning. No real agents yet — this phase builds the visual foundation on mock data.

**Duration estimate:** 1-2 weeks

**Success criteria:**

- Can submit a task (mock input)
- Master node appears with thinking animation
- Mock subtask nodes branch from master after 3-5 seconds
- Subtasks can be approved via the approval bar
- After approval, nodes transition through all states (running → done, or retrying → re-plan → human)
- Final node shows mock diff preview
- All animations feel polished

## What this phase does NOT include

Defer these to later phases:

- Real agent integration (Phase 2)
- Git worktree logic (Phase 2)
- Actual file editing (Phase 2)
- Cost tracking (Phase 6)
- Auto-approve mode (Phase 7)
- Config files (Phase 5)
- Mono-repo detection (Phase 4)

## Step-by-step tasks

### Step 1: Project scaffolding

Set up the Tauri v2 + React + TypeScript project.

```bash
pnpm create tauri-app whalecode --template react-ts
cd whalecode
pnpm install
```

**Configure:**

- Tailwind CSS with tokens from `docs/design-system.md` (tailwind.config.ts)
- Zustand: `pnpm add zustand`
- XState: `pnpm add xstate @xstate/react`
- React Flow: `pnpm add @xyflow/react`
- Dagre (auto-layout): `pnpm add @dagrejs/dagre` (plus `pnpm add -D @types/dagre` if the types aren't bundled)
- Framer Motion: `pnpm add framer-motion`
- Lucide: `pnpm add lucide-react`
- ESLint + Prettier with TypeScript rules
- Vitest for tests: `pnpm add -D vitest @testing-library/react`

**Create initial directory structure** as specified in `CLAUDE.md`.

**Verify:** `pnpm tauri dev` launches an empty Tauri window successfully.

### Step 2: Design tokens and primitives

Before any components, set up the foundation.

**a) Tailwind config** (`tailwind.config.ts`):

- Define all color tokens from `docs/design-system.md` section "Tailwind config tokens"
- Configure font families: `mono` → JetBrains Mono, `sans` → Inter
- Extend spacing scale if needed (default Tailwind scale already covers 4/8/16/24/48)

**b) Global styles** (`src/index.css`):

- Load JetBrains Mono and Inter from Google Fonts or local
- Body: `bg-bg-primary text-fg-primary font-mono`
- Set CSS reset basics

**c) Primitive components** (`src/components/primitives/`):

- `Button.tsx` — three variants (primary, secondary, ghost) per design-system spec
- `Chip.tsx` — default, agent-colored, package variants
- `Input.tsx` — size variants (hero, compact)

Each primitive should have a Vitest test for rendering and interaction.

### Step 3: Graph state machine

Model a subtask node as a formal state machine using XState.

**States:** `idle` → `thinking` → `proposed` → `approved` → `running` → `retrying` → `running` → `done`
**Alternate paths:** `running` → `failed` → `escalating` → `done` (after re-plan) OR `human_escalation`
**Also:** `waiting` (blocked on dependency) → `approved` → `running`, `skipped` (user rejected)

**File:** `src/state/nodeMachine.ts`

**Events the machine responds to:**

- `PROPOSE` → `idle` to `proposed`
- `APPROVE` → `proposed` to `approved`
- `SKIP` → `proposed` to `skipped`
- `START` → `approved` to `running`
- `FAIL` → `running` to `retrying` (first time) or `failed` (after retry)
- `RETRY_SUCCESS` → `retrying` to `running`
- `COMPLETE` → `running` to `done`
- `ESCALATE` → `failed` to `escalating`
- `REPLAN_DONE` → `escalating` to `done` (master made a new plan)
- `HUMAN_NEEDED` → `escalating` to `human_escalation`

**Test:** Write XState test cases asserting correct transitions for each event.

### Step 4: Zustand graph store

**File:** `src/state/graphStore.ts`

Store shape:

```typescript
type GraphState = {
  runId: string | null;
  taskInput: string;
  masterNode: MasterNodeData | null;
  subtasks: SubtaskNodeData[];
  finalNode: FinalNodeData | null;
  status: 'idle' | 'planning' | 'awaiting_approval' | 'running' | 'merging' | 'done' | 'failed';
  actions: {
    submitTask: (input: string) => void;
    approveSubtasks: (ids: string[]) => void;
    rejectAll: () => void;
    updateSubtaskState: (id: string, event: NodeEvent) => void;
    appendLogToNode: (id: string, line: string) => void;
    reset: () => void;
  };
};
```

Keep the store lean. UI-specific ephemeral state (hover, expanded) stays in components via `useState`.

### Step 5: React Flow canvas

**File:** `src/components/graph/GraphCanvas.tsx`

- Import React Flow. Set up the canvas to fill the main viewport area.
- Custom node types registered: `master`, `worker`, `final`.
- Use Dagre for auto-layout. Orientation: top-to-bottom.
- Disable panning/zooming for v2 (focused single-screen view). Canvas size auto-fits content.
- Custom edges: simple straight lines, `1px solid border-default`, animated during active runs.

### Step 6: Node components

**File:** `src/components/nodes/MasterNode.tsx`

Visual spec from `docs/design-system.md` section "Node (graph element)".

Structure:

```tsx
<NodeContainer agentColor="master" state={state}>
  <Header>
    <StatusDot color="master" />
    <Label>MASTER</Label>
    <Meta>{tokenCount}</Meta>
  </Header>
  <Title>{title}</Title>
  <Subtitle>{subtitle}</Subtitle>
</NodeContainer>
```

**File:** `src/components/nodes/WorkerNode.tsx`

Similar structure, plus:

- Agent color variant (passed as prop: claude/gemini/codex)
- Checkbox in header when state is `proposed`
- Status label matches state
- Body shows title, package chip (if any), and optional "Why?" section when proposed
- Log preview box at bottom when state is `running` or later
- Assigned-agent chip at bottom when state is `proposed` or `approved`

**File:** `src/components/nodes/FinalNode.tsx`

- Gray dashed border in `waiting` state
- Activates when all subtasks are done
- Shows aggregate mock diff (just a placeholder list of file names for now)
- Contains `[Apply to branch]` and `[Discard all]` buttons

### Step 7: Top bar, empty state, and footer

**File:** `src/components/shell/TopBar.tsx`

- Left: app name, current repo, mono-repo badge (mock: "Mono-repo · 4 packages")
- Right: Master agent chip (shows "Claude Code", clickable but for v2 no-op dropdown)

**File:** `src/components/shell/EmptyState.tsx`

- Centered layout
- "WhaleCode" title
- Tagline: "Your AI team, orchestrated visually"
- Hero input: "What should the team build?" (24px font)
- Below input: keyboard hint with `Enter` key chip
- Bottom: keyboard shortcuts row (⌘K, ⌘H, ⌘T, ⌘,)

**File:** `src/components/shell/Footer.tsx`

- Fixed bottom row, 32px tall, `border-subtle` top divider, `fg-tertiary` text at 11px.
- **Left:** agent status — "3 agents ready · claude-code · gemini-cli · codex-cli". The count reflects detected/available agents; individual names are `Chip` components in `default` variant.
- **Right:** last-run summary — "Last run: 2h ago · $0.24". Hidden entirely when no prior run exists.
- Phase 1 uses hard-coded mock values; Phase 2 wires this to real agent-availability checks and the run history store. Do not attempt live data here yet.
- Never compete with the approval bar: when `ApprovalBar` is mounted (status `awaiting_approval`), the footer hides. They never stack.

### Step 8: Approval bar

**File:** `src/components/approval/ApprovalBar.tsx`

- Animated using Framer Motion: slides up from bottom when `graphStore.status === 'awaiting_approval'`
- Left: message "Master proposes N subtasks. Approve to start."
- Right: three buttons (Reject all, Approve selected, Approve all)
- Full-width, fixed to bottom of canvas area

### Step 9: Mock orchestration flow

**File:** `src/lib/mockOrchestration.ts`

Simulates the entire lifecycle deterministically. Used only in Phase 1 — will be replaced by real agent calls in Phase 2.

**Flow:**

1. User submits task.
2. After `2000ms`, master transitions thinking → planning.
3. After another `4000ms`, master produces 4 mock subtasks. Status → `awaiting_approval`.
4. User approves.
5. Subtasks transition to `running` staggered by `500ms` each.
6. Mock log lines stream into each subtask every `200-800ms`.
7. One subtask is programmed to fail on first attempt → retries → succeeds.
8. Another subtask fails twice, triggering a master re-plan (demonstrate Layer 2).
9. After all subtasks done, final node activates with mock diff.

This function controls the entire demo. It's the scripted "play" that validates the whole visual system.

### Step 10: App assembly

**File:** `src/App.tsx`

```tsx
export default function App() {
  const status = useGraphStore((s) => s.status);
  return (
    <div className="flex h-screen w-screen flex-col bg-bg-primary text-fg-primary">
      <TopBar />
      <main className="relative flex-1 overflow-hidden">
        {status === 'idle' || status === 'applied' ? <EmptyState /> : <GraphCanvas />}
        <ApprovalBar />
      </main>
      <Footer />
    </div>
  );
}
```

ApprovalBar is an **overlay inside `<main>`**, not a sibling of `<Footer>`. That way the slide-up animation rides over the graph without reflowing the page when it appears/disappears, and `AnimatePresence` inside the bar can own its own visibility based on `status === 'awaiting_approval'`. EmptyState also renders on `applied` so the Apply-to-branch flow loops cleanly back to a fresh prompt.

### Step 11: Polish pass

Before declaring Phase 1 done, verify:

- All animations run smoothly at 60fps
- No layout shifts when nodes change state
- Approval bar slide-in feels responsive, not sluggish
- Log streaming doesn't cause cumulative layout jumps
- Checkboxes in proposed subtasks are keyboard-navigable
- Enter in empty-state input triggers submission
- Dark theme contrast passes WCAG AA on all text

## Testing

- Unit tests: XState machine transitions, Zustand store actions, primitive components
- Integration tests: Full mock orchestration end-to-end (happy path + retry path + human escalation)
- Visual tests: Storybook optional in Phase 1 — add in Phase 5 if helpful

## Files you'll create

By the end of Phase 1:

```
src/
├── components/
│   ├── graph/GraphCanvas.tsx
│   ├── nodes/MasterNode.tsx
│   ├── nodes/WorkerNode.tsx
│   ├── nodes/FinalNode.tsx
│   ├── approval/ApprovalBar.tsx
│   ├── shell/TopBar.tsx
│   ├── shell/EmptyState.tsx
│   ├── shell/Footer.tsx
│   └── primitives/Button.tsx, Chip.tsx, Input.tsx
├── state/
│   ├── nodeMachine.ts
│   └── graphStore.ts
├── lib/
│   └── mockOrchestration.ts
└── App.tsx
```

Approximately 15 files, ~1500-2000 lines of TypeScript.

## How to know you're done

Run `pnpm tauri dev`. You should be able to:

1. See empty state with centered prompt
2. Type a task, press Enter
3. Watch master node appear and "think"
4. See 4 subtasks branch from master in proposed state
5. See the approval bar slide up
6. Check/uncheck some subtasks
7. Click "Approve all"
8. Watch subtasks run in parallel with streaming log output
9. See one subtask retry after a failure
10. See another subtask fail, trigger re-plan, master generates new subtasks
11. Approve the re-plan
12. Watch everything complete
13. See the final node show a mock diff
14. Click "Apply to branch" and see the success state

If all 14 steps work smoothly, Phase 1 is complete.

## Common pitfalls

- **Don't use `useState` for node state.** Use the XState machine + Zustand store. Local state will fragment the truth.
- **Don't hard-code colors or spacing.** Use Tailwind tokens. You'll regret it in Phase 6 polish.
- **Don't build real IPC to Tauri yet.** Mock everything in Phase 1. IPC belongs in Phase 2.
- **Don't skip the fail path.** Most bugs hide in fail handling. Make sure retry → re-plan → human flows work end-to-end on mock data.
- **Don't add scope.** This phase is visual foundation only. Real agents, config files, cost tracking — all deferred.
