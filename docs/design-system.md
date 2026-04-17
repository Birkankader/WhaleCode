# Design system

Visual tokens, spacing, animation. Read this when building UI components.

## Philosophy

> Show, don't tell. Whitespace is trust. Motion carries meaning.

Every visual decision ties back to these three. If something violates them, rework it.

## Colors

**Dark mode only in v2.** Light mode may come in v2.5+ but is not in scope now.

### Base palette

| Token | Hex | Use |
|-------|-----|-----|
| `bg-primary` | `#0A0A0A` | Main application background |
| `bg-elevated` | `#141414` | Nodes, modals, input fields |
| `bg-subtle` | `#1F1F1F` | Hover states, keyboard key chips |
| `fg-primary` | `#E8E8E8` | Primary text, active content |
| `fg-secondary` | `#8A8A8A` | Secondary text, metadata, timestamps |
| `fg-tertiary` | `#6A6A6A` | Hints, placeholder text, muted |
| `border-subtle` | `#1F1F1F` | Divider lines, section separators |
| `border-default` | `#2A2A2A` | Component borders, input outlines |

### Agent colors

Each agent has its own color. This is functional, not decorative — users identify work at a glance.

| Agent | Color | Hex | Background tint (node fill) |
|-------|-------|-----|------------------------------|
| Master | Amber | `#F59E0B` | `#1A1407` (deep amber) |
| Claude Code | Cyan | `#7DD3FC` | `#0D1A1F` (deep cyan) |
| Gemini CLI | Purple | `#C4B5FD` | `#12091F` (deep purple) |
| Codex CLI | Green | `#86EFAC` | `#0B1A10` (deep green) |

The master color is amber because amber signals leadership and caution simultaneously — both fitting for a planner. Worker colors are chosen for distinctness in dark mode and accessibility (all pass WCAG AA on `bg-primary`).

### Status colors

| State | Color | Hex | Node fill |
|-------|-------|-----|-----------|
| Done / Success | Green | `#10B981` | Keep worker color, add green dot |
| Retrying / Re-planning | Amber | `#FBBF24` | `#1F1607` |
| Failed (terminal) | Red | `#EF4444` | `#1F0A0A` |
| Proposed / Pending | Amber-muted | `#FBBF24` | `#141414` + dashed border |
| Waiting (blocked) | Gray | `border-default` | `#141414` + dashed border, 0.8 opacity |

**Rule:** Don't use alarm-red for cost. Cost is not bad. Red is reserved for actual errors.

### Tailwind config tokens

```typescript
// tailwind.config.ts
export default {
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#0A0A0A',
          elevated: '#141414',
          subtle: '#1F1F1F',
        },
        fg: {
          primary: '#E8E8E8',
          secondary: '#8A8A8A',
          tertiary: '#6A6A6A',
        },
        border: {
          subtle: '#1F1F1F',
          DEFAULT: '#2A2A2A',
        },
        agent: {
          master: '#F59E0B',
          claude: '#7DD3FC',
          gemini: '#C4B5FD',
          codex: '#86EFAC',
        },
        status: {
          success: '#10B981',
          retry: '#FBBF24',
          failed: '#EF4444',
          pending: '#FBBF24',
        },
      },
    },
  },
};
```

## Typography

**Primary font:** JetBrains Mono — used for ALL UI text.
**Prose font:** Inter — only for long-form content (help dialogs, release notes, documentation strings).

Never mix fonts within the same component. The whole UI reads as code-adjacent. That's the point.

### Scale

Only four sizes in v2. Do not add more without explicit approval.

| Size | Use |
|------|-----|
| `11px` | Keyboard hints, status badges, fine metadata |
| `12px` | Timestamps, secondary info, small labels |
| `14px` | Base — body text, most UI text |
| `18px` | Node titles, section headings |
| `24px` | Hero prompt only (empty state, "What should the team build?") |

### Weights

Only two weights:

- `400` (regular) for body text
- `500` (semibold) for emphasis and headings

**Never use 600 or 700.** They read as visual noise in monospace.

### Casing

**Sentence case everywhere.** Never `ALL CAPS`, never `Title Case`.

Exception: Three-letter status labels inside node headers can use all caps with reduced font size (`9px`, `letter-spacing: 0.5px`). Example: `RUNNING`, `DONE`, `FAILED`. This is a deliberate visual rhythm and the only place caps are allowed.

## Spacing

Strict scale. Any pixel value outside this list is forbidden without justification.

- `4px` — tightest (internal badge padding, icon gaps)
- `8px` — tight (between related elements)
- `16px` — comfortable (between components)
- `24px` — generous (between sections)
- `48px` — roomy (outer margins of main canvas)

**Component-specific:**
- Node padding: `16px` (12px vertical acceptable for compact nodes)
- Node-to-node gap: `24px`
- Canvas outer margin: `48px`
- Top bar height: `48px` (including borders)
- Approval bar height: `56px`

## Borders & radius

- **Border width:** Always `1px`. Focus/highlight states use `2px`.
- **Border radius:** `8px` for components, `10px` for input fields and primary containers, full (`9999px`) only for avatar circles and pill badges.
- Never nest rounded corners inside rounded corners at the same radius. Inner elements should use a smaller radius or none.
- Never use one-sided borders with `border-radius`. Either full border with radius, or single-side border with `border-radius: 0`.

## Animation

Every animation encodes information. Decorative motion is prohibited.

| What | Timing | Easing |
|------|--------|--------|
| Node state change | `200ms` | `ease-out` |
| Node expand/collapse | `250ms` | `ease-in-out` |
| Approval bar slide in/out | `300ms` | `ease-out` |
| Thinking pulse | `1.5s` loop | `ease-in-out`, opacity 0.6 ↔ 1.0 |
| Running glow | `2s` loop | box-shadow 0 → 8px soft amber/cyan/purple |
| Retry pulse | `1s` loop | faster than thinking, signals urgency |
| Success checkmark | `300ms` | scale 0 → 1 with slight overshoot |
| Streaming cursor blink | `1s` | hard step (binary) |
| Text character appearance | `5ms` per char | linear (capped for long outputs) |

**No:**
- Decorative float/bob animations
- Background gradients that shift
- Particle effects or confetti
- Rotating spinners (use pulse instead — more composable with theme)

## Component primitives

Build these first. Everything else composes them.

### Button

Three variants:

```tsx
// Primary (amber, high emphasis — used for Approve all, Apply to branch)
<Button variant="primary">Approve all</Button>

// Secondary (outlined amber — used for partial approvals)
<Button variant="secondary">Approve selected</Button>

// Ghost (transparent, muted — used for Reject, Cancel, destructive)
<Button variant="ghost">Reject</Button>
```

Specs:
- Font size: `12px`, weight `500`.
- Padding: `7px 14px`.
- Radius: `5px`.
- No shadow. Focus ring: `2px` outline in amber, `2px` offset.
- Hover: slight bg shift (primary → 10% lighter amber, ghost → `bg-subtle`).
- Active: `scale(0.98)` briefly on press.

### Chip

Small rounded-rectangle label. Used for master agent selector, package name, keyboard hints.

```tsx
<Chip>claude-code</Chip>                  // default gray
<Chip variant="agent-master">Master</Chip> // agent-colored
<Chip variant="package">apps/web</Chip>    // mono-repo package indicator
```

Specs:
- Font size: `11px` (sometimes `10px` for inline chips within a node).
- Padding: `2px 8px`.
- Radius: `4px`.
- Background: `bg-elevated` with `border-default`. Agent variants use the agent's deep-tint bg.

### Node (graph element)

Three main types: `MasterNode`, `WorkerNode`, `FinalNode`.

**All share:**
- `border-radius: 8px`
- `padding: 10px 12px` (compact) or `12px 18px` (standard)
- `background: bg-elevated`
- Header row with status indicator (colored dot) + agent/role label + meta (right-aligned)
- Body: title (14px) + subtitle (11px, muted) + optional log preview

**State-specific:**
- **Thinking/Running:** solid border in agent color + glow box-shadow
- **Proposed:** dashed border in `status-pending`
- **Retrying:** solid border in `status-retry`, faster pulse
- **Done:** keep solid agent-color border, add green status dot
- **Failed:** solid border in `status-failed`, error preview in log area
- **Waiting:** dashed border in `border-default`, `0.8` opacity

### Input

Used for the main task input.

Specs:
- Font size: `20px` in empty state (the hero prompt), `14px` after submission (collapsed top bar).
- Padding: `18px 20px` (empty), `10px 14px` (collapsed).
- Background: `bg-elevated`.
- Border: `1px solid border-default`. Focus: `2px solid agent-master`.
- Placeholder: `fg-tertiary`.
- Cursor: blinking caret in `fg-primary`.

### Approval bar

Sticky bottom-of-canvas bar that appears when subtasks are proposed.

Specs:
- Height: `56px`.
- Background: `bg-elevated`.
- Top border: `1px solid agent-master`.
- Slides up from bottom with `300ms ease-out` when proposed subtasks appear.
- Contents: left-aligned message + right-aligned buttons (Reject all, Approve selected, Approve all).
- Only one approval bar visible at a time.

## What NOT to build

Explicit forbiddens:

- **Sidebar navigation** — kills the flow, introduces a competing focus point
- **Tabs** — the graph IS the content; there's nothing else to tab between
- **Modals for approval** — use the sticky bottom bar. Modals break context.
- **Tooltips on hover** (except keyboard shortcut hints) — if info matters, show it
- **Progress bars** — infinite pulse animation communicates "working" better than fake progress
- **Breadcrumbs** — hierarchy is visible in the graph itself
- **Icon-only buttons** — always pair icons with labels (icon + text)
- **Alarm colors for cost** — cost is information, not a warning
- **shadcn/ui components** — write custom minimal ones following this system
- **Multiple font families in one component**

## Layout rules

- **One canvas.** The graph fills the main area. Top bar and footer are the only other horizontal regions.
- **No nested scrolls.** If content overflows, the graph pans. Individual nodes expand inline.
- **Responsive minimums:** Minimum window size `900px × 600px`. Below that, show "Window too small" message.
- **No multi-column content areas** except the graph's node grid.

## Accessibility

- All interactive elements must have visible focus rings (`2px` amber outline, `2px` offset).
- Keyboard navigation: Tab through all interactive elements, Enter/Space to activate.
- Color is never the only indicator of state. Every state has both a color AND a text label AND (where applicable) a dot indicator.
- Don't assume color-blind users can distinguish green/red — state labels ("DONE", "FAILED") always accompany color changes.
