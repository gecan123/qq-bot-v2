# Playground Observability Design

Date: 2026-04-04
Scope: `apps/admin-web` playground
Status: Approved for planning

## Goal

Upgrade the admin web playground from a result-oriented chat sandbox into a run-oriented debugging console.

The primary goal is observability of the full agent execution path for a single playground run:

- how many loops executed
- what the agent thought in each stage
- why it called a tool
- why it continued looping or terminated
- how the current run differs from recent runs

This is a personal experimental project. The playground may expose full raw thinking without redaction, truncation, or permission controls.

## Current State

The current playground page renders:

- a small config bar for group and sender
- a chat-like message history
- the final bot answer
- a simple tool trace assembled from `tool_call` / `tool_result` pairs

This is enough to see tool usage, but not enough to explain full execution behavior. The current UI does not clearly expose:

- loop count
- stage transitions
- raw think content
- decision points between think and tool calls
- termination reasons as first-class data
- comparisons between runs

## Non-Goals

This design does not include:

- database persistence for run traces
- multi-user access or sharing
- redaction, masking, or truncation of raw think
- token-level visualization or streaming token timelines
- broad observability for the whole system outside playground runs

## Product Direction

The playground should become a `Timeline First` debugging console.

The user still submits a message from a chat-like input, but the main visual focus shifts away from chat bubbles and toward a structured trace of a single run.

The target interaction model is:

1. Submit a test message.
2. Receive a structured run trace.
3. Inspect each phase and each loop.
4. Open any step to see summary, raw think, tool IO, and raw event payload.
5. Compare the current run with recent runs in the same browser session.

## Information Architecture

The page should be reorganized into four areas.

### 1. Top Control Bar

Contains the existing playground inputs plus debug-oriented controls:

- group selector
- sender name
- message composer
- submit button
- `show raw think`
- `auto-expand loops`
- `history compare`
- optional debug-level toggles if needed later

The control bar remains lightweight. It configures the run and triggers execution.

### 2. Main Timeline Area

This becomes the primary surface.

Each submitted message creates a `Run Trace Card` rather than only appending a bot message bubble.

The trace card is organized by phases:

- `receive`
- `load_context`
- `plan`
- `loop #n`
- `finalize`

Each phase or loop node should display:

- title
- summary
- elapsed time
- state
- enter reason when relevant
- exit reason when relevant

Loop nodes are the most important content and should auto-expand by default.

### 3. Step Inspector

Selecting any node in the timeline opens a detail panel for that node.

The inspector should provide four tabs:

- `Summary`
- `Raw Think`
- `Tool IO`
- `Raw Event`

This preserves readability in the timeline while still allowing full-fidelity inspection.

### 4. Recent Runs

The playground should keep recent runs in page memory for quick comparison.

Each recent run summary should show:

- total elapsed time
- loop count
- tool count
- final state
- final answer preview

Selecting a recent run switches the main trace to that run. Comparing two runs should highlight the most important behavioral differences.

## Trace Model

The backend response should move from an unstructured step list toward a first-class `RunTrace` model.

### Top-Level Objects

#### Run

Represents one full playground execution.

Recommended fields:

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

#### Phases

Phases are a rendering and grouping concept:

- `receive`
- `load_context`
- `plan`
- `loop`
- `finalize`

`loop` is repeatable and contains loop-indexed events.

#### Events

The trace must preserve a strictly ordered event stream for the full run.

Recommended event types:

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

Each event should carry enough metadata to support timeline rendering and debugging.

Recommended shared fields:

- `id`
- `type`
- `phase`
- `loopIndex` when applicable
- `timestamp`
- `elapsedMs`
- `title`
- `summary`
- `raw`

### Why `think` and `decision` Are Separate

The timeline should not force users to read long raw think blocks to understand behavior.

`think` stores the raw reasoning text.
`decision` stores the structured conclusion that explains the next action, for example:

- context is insufficient, call `db_read`
- current tool result is enough, continue to finalize
- reached max loops, abort

This separation keeps the UI readable while preserving full raw detail in the inspector.

### Tool Event Pairing

Tool calls and results should be explicitly linked by `callId`.

The current UI infers pairing by adjacent order and tool name. That approach becomes fragile if the same tool is called repeatedly in one run. Explicit pairing avoids mismatches and keeps the trace stable.

## Interaction Requirements

The debugging console must directly answer these questions:

1. How many loops ran?
2. What did the agent think in each loop?
3. Why was a specific tool called?
4. Why did the agent continue or stop after a tool result?
5. How did this run differ from the previous run?

To support those questions, the UI should provide the following behaviors.

### Timeline Defaults

- Loop nodes are expanded by default.
- Non-loop phases may default to collapsed summaries.
- Each node shows title, summary, and timing metadata without requiring a click.

### Inspector Tabs

The inspector should let users move from readable summaries to full raw data:

- `Summary`: user-friendly explanation of the step
- `Raw Think`: complete raw thought text
- `Tool IO`: tool input, output, and error
- `Raw Event`: the raw event payload

### Filters

The trace should support quick filtering:

- all events
- loop-specific view
- think-only view
- tool-only view

This is important when a run contains many steps.

### Comparison

The first comparison scope is previous runs stored in browser memory for the active page session.

The comparison should highlight:

- final state
- loop count
- tool count
- phase timing
- final answer
- added or removed steps such as extra tool calls or extra think events

### Termination Visibility

Termination reason must be treated as first-class data and displayed clearly on the final card.

Examples:

- completed with answer
- stopped by max loops
- aborted by tool error
- fallback due to empty result

This should not be hidden inside the final answer text.

## Backend Instrumentation Strategy

The implementation should introduce a dedicated trace recorder inside the playground execution path.

### Recorder Responsibilities

The recorder should:

- create the trace at run start
- track current phase
- track current loop index
- append think, decision, tool, and termination events
- produce a complete `RunTrace` object at the end

### Integration Strategy

The trace recorder should be passed into the real playground agent flow.

The playground layer should not reconstruct traces by parsing logs or guessing transitions after the fact. Each key runtime decision point should emit trace events directly.

### Raw Think Handling

Raw think should be returned as event data without redaction or truncation.

This is acceptable because the playground is explicitly a personal experimental tool and not a shared production surface.

### Compatibility

The API may temporarily return both:

- legacy `steps`
- new `trace`

The frontend should migrate to `trace` as the primary rendering source. The old `steps` field can be kept only as a short-lived compatibility bridge.

## Frontend Rendering Strategy

The current `ToolCallTrace`-centric presentation should be replaced by:

- a run-oriented timeline
- a step inspector
- a recent-runs panel

The chat input remains, but chat bubbles become secondary. The main story of the page is the trace, not the transcript.

## Progressive Rollout Plan

Implementation should proceed in this order:

1. Define `RunTrace`, `TraceEvent`, and `TerminationReason`.
2. Add a trace recorder to the playground run path.
3. Return `trace` from the playground API.
4. Replace the current tool trace rendering with `Timeline + Inspector`.
5. Add recent runs and previous-run comparison in page memory.
6. Polish interaction defaults and visual compression.

This order keeps scope controlled and ensures the backend trace model is stable before investing in UI complexity.

## Risks and Tradeoffs

### Risk: Oversized Raw Think Payloads

Returning full raw think may create large payloads and visually noisy nodes.

This is acceptable for the current project goals. The design already mitigates the readability issue by keeping raw think inside the inspector instead of the default timeline presentation.

### Risk: Too Many Event Types

A trace model with many event types can become hard to maintain.

This is mitigated by keeping the event taxonomy narrow and focused on real runtime transitions that matter for debugging and planning.

### Risk: Scope Drift Into a Full Observability System

The desire to compare runs can easily expand into persistence, dashboards, and long-term analytics.

This spec intentionally limits comparison to recent runs held in page memory only.

## Open Questions Resolved

The following decisions are fixed for implementation planning:

- use `Timeline First` rather than chat-first or metrics-first
- display both structured summaries and full raw think
- do not redact or truncate raw think
- optimize for single-run debugging first
- support comparison with recent runs, but do not persist traces yet

## Ready-for-Planning Summary

The next planning step should treat this as a focused admin-web playground enhancement with two major workstreams:

- backend trace instrumentation for playground runs
- frontend redesign around timeline, inspector, and recent-run comparison

The implementation plan should avoid persistence, permissions, and analytics infrastructure.
