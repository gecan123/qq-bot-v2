# Playground Observability Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the admin-web playground into a run-oriented debugging console with traceable phases, loops, raw think visibility, and recent-run comparison.

**Architecture:** Introduce a first-class `RunTrace` model in the bot backend and emit structured trace events directly from the playground agent loop. Replace the current tool-pair rendering in admin-web with a timeline-first UI backed by the new trace object and keep recent runs in client memory for comparison.

**Tech Stack:** TypeScript, Next.js App Router, React 19, Tailwind CSS, Node HTTP routes, existing agent loop, `node:test`

---

## File Structure

### Backend trace model and instrumentation

- Create: `src/agent/trace.ts`
  Defines trace types, recorder helpers, and termination reason helpers used by the playground.
- Modify: `src/agent/loop.ts`
  Emits trace events during each loop and returns structured metadata together with the loop result.
- Modify: `src/agent/types.ts`
  Adds trace-aware return types used by the backend and playground.
- Create: `src/agent/trace.test.ts`
  Verifies recorder behavior and event ordering without touching HTTP.

### Playground backend response

- Modify: `src/server/playground.ts`
  Builds a `RunTrace`, keeps temporary legacy `steps`, and returns both.
- Create: `src/server/playground.test.ts`
  Verifies the playground result shape includes trace fields and preserves legacy compatibility.

### Admin-web rendering

- Create: `apps/admin-web/components/playground/types.ts`
  Shared client-side trace types imported by timeline and inspector components.
- Create: `apps/admin-web/components/playground/run-timeline.tsx`
  Timeline-first trace rendering with phase and loop grouping.
- Create: `apps/admin-web/components/playground/step-inspector.tsx`
  Node detail panel for summary, raw think, tool IO, and raw event tabs.
- Create: `apps/admin-web/components/playground/recent-runs.tsx`
  Recent run list and previous-run comparison surface.
- Modify: `apps/admin-web/components/playground/agent-sandbox.tsx`
  Switches from chat-centric rendering to trace-centric rendering and stores recent runs in client memory.
- Modify: `apps/admin-web/components/playground/tool-call-card.tsx`
  Either remove usage or reduce it to a compatibility helper if still needed during transition.

### Verification and hygiene

- Modify: `.gitignore`
  Ignore `.superpowers/` generated brainstorming artifacts.

## Trace Schema Contract

Every backend and frontend change must align on one trace schema contract.

### Required run fields

- `runId`
- `groupId`
- `senderName`
- `userMessage`
- `startedAt`
- `endedAt`
- `elapsedMs`
- `finalState`
- `finalAnswer`
- `terminationReason`

### Required event fields

- `id`
- `type`
- `phase`
- `loopIndex`
- `timestamp`
- `elapsedMs`
- `title`
- `summary`
- `raw`

### Allowed phases

- `receive`
- `load_context`
- `plan`
- `loop`
- `finalize`

### Allowed event types

- `run_started`
- `phase_started`
- `think`
- `loop_started`
- `tool_call`
- `tool_result`
- `decision`
- `loop_finished`
- `phase_finished`
- `run_finished`
- `run_aborted`
- `run_error`

### Minimum termination reasons

- `final_answer`
- `implicit_text`
- `empty_response`
- `max_steps_exceeded`
- `tool_error`
- `runtime_error`

This contract must be shared by `src/agent/trace.ts` and `apps/admin-web/components/playground/types.ts`.

## Task 1: Define and test the trace model

**Files:**
- Create: `src/agent/trace.ts`
- Create: `src/agent/trace.test.ts`
- Modify: `src/agent/types.ts`

- [ ] **Step 1: Write the failing trace recorder tests**

```ts
test('trace recorder appends loop and think events in order', () => {
  const recorder = createTraceRecorder({ runId: 'run_1', groupId: 42, senderName: 'tester', userMessage: 'hi' })
  recorder.phaseStarted('plan')
  recorder.think({ phase: 'plan', summary: 'need memory', raw: 'I should inspect memory first' })
  recorder.loopStarted(1)
  recorder.decision({ phase: 'loop', loopIndex: 1, summary: 'call db_read', raw: { tool: 'db_read' } })

  const trace = recorder.finish({ finalState: 'final', finalAnswer: 'done', terminationReason: 'final_answer' })

  assert.deepEqual(trace.events.map((event) => event.type), [
    'run_started',
    'phase_started',
    'think',
    'loop_started',
    'decision',
    'run_finished',
  ])
})

test('trace recorder includes required fields and termination metadata', () => {
  const recorder = createTraceRecorder({ runId: 'run_1', groupId: 42, senderName: 'tester', userMessage: 'hi' })
  recorder.phaseStarted('receive')
  recorder.phaseFinished({ phase: 'receive', summary: 'message accepted' })
  const trace = recorder.finish({ finalState: 'aborted', terminationReason: 'max_steps_exceeded' })

  assert.equal(trace.terminationReason, 'max_steps_exceeded')
  const event = trace.events[0]
  assert.ok(event?.id)
  assert.ok(event?.timestamp)
  assert.ok('elapsedMs' in (event ?? {}))
  assert.ok('summary' in (event ?? {}))
  assert.ok('raw' in (event ?? {}))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/agent/trace.test.ts`
Expected: FAIL because `createTraceRecorder` and trace types do not exist.

- [ ] **Step 3: Write the minimal trace model and recorder**

```ts
export interface RunTrace { /* run fields + events */ }
export function createTraceRecorder(input: TraceRecorderInput) {
  // push ordered events, assign ids, compute elapsed times, finish run
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/agent/trace.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/trace.ts src/agent/trace.test.ts src/agent/types.ts
git commit -m "feat: add playground trace model"
```

## Task 2: Instrument the playground backend with trace output

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/server/playground.ts`
- Create: `src/server/playground.test.ts`

- [ ] **Step 1: Write the failing backend tests**

```ts
test('playground run returns trace with loop metadata and final termination', async () => {
  const result = await runPlaygroundWithFakes()
  assert.equal(result.trace.finalState, 'final')
  assert.equal(result.trace.terminationReason, 'final_answer')
  assert.ok(result.trace.events.some((event) => event.type === 'loop_started'))
})

test('playground run emits receive, load_context, plan, loop, and finalize phases', async () => {
  const result = await runPlaygroundWithFakes()
  const phases = Array.from(new Set(result.trace.events.map((event) => event.phase)))
  assert.deepEqual(phases, ['receive', 'load_context', 'plan', 'loop', 'finalize'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test src/server/playground.test.ts src/agent/loop.test.ts`
Expected: FAIL because no trace is emitted from the loop or playground result.

- [ ] **Step 3: Implement trace instrumentation in the loop and playground route**

```ts
const recorder = params.traceRecorder
recorder?.phaseStarted('receive')
recorder?.phaseFinished({ phase: 'receive', summary: 'request validated' })
recorder?.phaseStarted('load_context')
recorder?.phaseFinished({ phase: 'load_context', summary: 'context ready' })
recorder?.phaseStarted('plan')
recorder?.think({ ... })
recorder?.toolCall({ callId: call.id, name: call.name, input: call.args })
recorder?.toolResult({ callId: call.id, name: call.name, output, durationMs })
recorder?.phaseStarted('finalize')
recorder?.phaseFinished({ phase: 'finalize', summary: 'answer prepared' })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/server/playground.test.ts src/agent/loop.test.ts src/agent/trace.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/loop.ts src/server/playground.ts src/server/playground.test.ts src/agent/types.ts
git commit -m "feat: add playground trace output"
```

## Task 3: Replace the playground UI with timeline, inspector, and recent runs

**Files:**
- Create: `apps/admin-web/components/playground/types.ts`
- Create: `apps/admin-web/components/playground/run-timeline.tsx`
- Create: `apps/admin-web/components/playground/step-inspector.tsx`
- Create: `apps/admin-web/components/playground/recent-runs.tsx`
- Modify: `apps/admin-web/components/playground/agent-sandbox.tsx`
- Modify: `apps/admin-web/components/playground/tool-call-card.tsx`

- [ ] **Step 1: Write the failing UI tests or shape assertions**

```ts
// If no UI test harness exists, add minimal pure-function tests for:
// - grouping events into timeline sections
// - selecting previous run for comparison
// - filtering all / loop / think / tool views
// - toggling show raw think / auto-expand loops / history compare
```

- [ ] **Step 2: Run tests or build to verify the current UI is missing the new trace surfaces**

Run: `cd apps/admin-web && pnpm build`
Expected: Either missing imports/tests fail after adding the new expectations, confirming the UI work is not implemented yet.

- [ ] **Step 3: Implement the timeline-first playground UI**

```tsx
<PlaygroundControls
  showRawThink={showRawThink}
  autoExpandLoops={autoExpandLoops}
  historyCompare={historyCompare}
/>
<RecentRuns runs={runs} selectedRunId={selectedRunId} comparisonRunId={comparisonRunId} />
<RunTimeline
  trace={activeRun.trace}
  filter={timelineFilter}
  selectedEventId={selectedEventId}
  onSelectEvent={setSelectedEventId}
  autoExpandLoops={autoExpandLoops}
/>
<StepInspector event={selectedEvent} trace={activeRun.trace} comparisonTrace={comparisonTrace} showRawThink={showRawThink} />
```

- [ ] **Step 4: Run build to verify the UI passes**

Run: `cd apps/admin-web && pnpm build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/admin-web/components/playground apps/admin-web/package.json
git commit -m "feat: redesign playground trace ui"
```

### Task 3 acceptance checklist

- control bar includes `show raw think`, `auto-expand loops`, and `history compare`
- timeline supports `all`, `loop`, `think`, and `tool` filters
- recent-run comparison highlights loop count, tool count, phase timing, final answer, and added or removed think or tool events
- selecting a timeline node updates the inspector with summary, raw think, tool IO, and raw event content

## Task 4: Verify end-to-end behavior and clean up repo hygiene

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Ignore brainstorming artifacts**

```gitignore
.superpowers/
```

- [ ] **Step 2: Run repository verification**

Run: `pnpm exec tsx --test src/agent/trace.test.ts src/server/playground.test.ts src/agent/loop.test.ts`
Expected: PASS

Run: `pnpm build`
Expected: PASS

Run: `cd apps/admin-web && pnpm build`
Expected: PASS

- [ ] **Step 3: Review the final playground manually**

Run:
```bash
pnpm dev
# in another terminal
cd apps/admin-web && pnpm dev
```

Manual check:
- submit a playground message
- inspect loop count and phase grouping
- open `Raw Think` for a selected event
- verify recent runs can switch and compare

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore brainstorm artifacts"
```
