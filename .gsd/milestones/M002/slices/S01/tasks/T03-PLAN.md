---
estimated_steps: 4
estimated_files: 3
skills_used: []
---

# T03: Wire humanizeError into DecompositionErrorCard and add decomposition-specific patterns

**Slice:** S01 — Decomposition & Error Pipeline
**Milestone:** M002

## Description

`DecompositionErrorCard.tsx` displays raw error strings to users — Rust internal messages like "Process xyz not found" or "not valid JSON". The `humanizeError()` function in `src/lib/humanizeError.ts` already has 18 pattern→friendly-message mappings but is never called in the decomposition error path. This task wires `humanizeError` into the error card display, adds 2-3 decomposition-specific patterns, and writes tests for the new patterns.

## Steps

1. **Add decomposition-specific patterns** to `src/lib/humanizeError.ts`:
   - Add these patterns to the `ERROR_PATTERNS` array (before the existing entries, since more specific patterns should match first):
   ```typescript
   [/Decomposition parse failed|not valid JSON|Could not parse decomposition/i,
    'The AI returned an unexpected response format. Try rephrasing your task or switching the master agent.'],
   [/Falling back to.*single task|Fallback:.*single task/i,
    'The task couldn\'t be broken into sub-tasks and will run as a single task instead.'],
   [/timed out during.*decomposition|Master agent timed out/i,
    'The orchestrator took too long breaking down your task. Try a simpler prompt or a different master agent.'],
   ```

2. **Wire `humanizeError` into `DecompositionErrorCard.tsx`**:
   - Add import: `import { humanizeError } from '@/lib/humanizeError';`
   - The current error derivation (lines 52-56) is:
     ```typescript
     const errorMessage =
       masterTask?.resultSummary ||
       orchestrationLogs.filter((l) => l.level === 'error').pop()?.message ||
       'The master agent failed to decompose the task into sub-tasks.';
     ```
   - Change to compute both raw and humanized:
     ```typescript
     const rawError =
       masterTask?.resultSummary ||
       orchestrationLogs.filter((l) => l.level === 'error').pop()?.message ||
       'The master agent failed to decompose the task into sub-tasks.';
     const errorMessage = humanizeError(rawError);
     ```
   - The display at line ~257 already shows `{errorMessage}` — this now shows the humanized version
   - The expandable "Orchestration Logs" section (~recentLogs) already shows raw log entries — no change needed there, raw detail is preserved

3. **Write tests** in `src/tests/humanizeError.test.ts`:
   - Add test cases for each new pattern:
     ```typescript
     it('maps decomposition parse failure to friendly message', () => {
       expect(humanizeError('Could not parse decomposition from agent output')).toContain('unexpected response format');
     });

     it('maps fallback single task to friendly message', () => {
       expect(humanizeError('Fallback: running original prompt as single task')).toContain('single task');
     });

     it('maps decomposition timeout to friendly message', () => {
       expect(humanizeError('Master agent timed out during task decomposition')).toContain('took too long');
     });
     ```

4. **Verify TypeScript compiles** — run `npx tsc --noEmit` to confirm no type errors were introduced.

## Must-Haves

- [ ] `humanizeError` imported and called in `DecompositionErrorCard.tsx` to wrap the error display text
- [ ] Raw error text still visible in expandable orchestration logs section (not replaced)
- [ ] At least 2 new decomposition-specific patterns in `humanizeError.ts`
- [ ] Tests for new patterns pass
- [ ] TypeScript compiles with zero errors

## Verification

- `npx vitest run src/tests/humanizeError.test.ts` — all tests pass (existing + new)
- `npx tsc --noEmit` — zero errors
- `rg "humanizeError" src/components/orchestration/DecompositionErrorCard.tsx` — at least 1 match (import + usage)
- `rg "parse decomposition\|single task\|timed out.*decomposition" src/lib/humanizeError.ts` — new patterns present

## Inputs

- `src/lib/humanizeError.ts` — existing humanizeError function with ERROR_PATTERNS array
- `src/components/orchestration/DecompositionErrorCard.tsx` — error message derivation at lines 52-56, display at line ~257
- `src/tests/humanizeError.test.ts` — existing test pattern (import, describe/it blocks, expect assertions)

## Expected Output

- `src/lib/humanizeError.ts` — 2-3 new decomposition-specific patterns added to ERROR_PATTERNS
- `src/components/orchestration/DecompositionErrorCard.tsx` — import humanizeError, wrap errorMessage display through it
- `src/tests/humanizeError.test.ts` — 3 new test cases for decomposition-specific error patterns
