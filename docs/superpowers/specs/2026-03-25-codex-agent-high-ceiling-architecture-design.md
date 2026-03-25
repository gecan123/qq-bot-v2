# Codex-Agent High-Ceiling Architecture Design

Date: 2026-03-25  
Repo: `qq-bot-v2`  
Status: Approved design (pre-implementation)

## 1. Goal And Scope

This design targets an experimental, high-ceiling architecture for `@` replies in QQ groups.

Primary goal:
- Replace the current high-level business-tool-driven reply path with a more general, agent-driven architecture that has higher capability ceiling.

In scope for v1:
- Direct replacement of the current `@` main reply path.
- Agentic loop with `maxSteps=12`.
- Atomic tools for DB + web retrieval.
- Read-only SQL access with strict execution guardrails.
- Fallback to single-turn reply on terminal loop failures (`max steps exceeded`, global timeout, adapter/system fatal error).
- Observability sufficient for iterative tuning.

Out of scope for v1:
- Planner/executor multi-agent decomposition.
- Full memory system redesign.
- Any write-capable DB tools.

## 2. Key Decisions (Locked)

The following decisions are confirmed:

1. Architecture objective is "advanced + higher upper bound", not conservative compatibility.
2. Main path will be directly replaced (no A/B dual entry for v1).
3. v1 capability closure is "group history + web search".
4. Agent loop allows up to 12 steps.
5. Initial chat context includes the latest 20 group messages.
6. `db_read` uses restricted raw SQL (not DSL).
7. Offline memory is a low-priority track and not a v1 blocker.

## 3. Recommended Architecture

Adopt "Atomic Capability Layer + Agent-Orchestrated Retrieval".

Core idea:
- Keep the model free to plan retrieval steps.
- Move safety, scope and stability boundaries into runtime guardrails.
- Avoid high-level business tools that hardcode reasoning paths.

### 3.1 Components

1. Agent Runtime Adapter
- Responsibility: connect model runtime with project-level `AgentLlmAdapter` contract.
- No business logic in adapter.

2. Atomic Tools Layer
- Replace high-level business tools with atomic capabilities.
- Tool set for v1:
  - `db_schema`
  - `db_read`
  - `web_search`
  - `final_answer`
- Optional near-term (`P1`): `fetch_url`

3. Execution Guardrail Layer
- Enforce read-only SQL and policy checks before execution.
- Enforce group scope, timeout, rows/size truncation.

4. Agent Loop
- Multi-step tool-calling loop, model-driven termination by `final_answer`.
- Continue across tool errors when possible.

5. At-Mention Entry
- `@` handling enters new agent loop by default.
- Legacy single-turn path retained only as fallback.

## 4. Tool Contract Design

### 4.1 `db_schema`
Purpose:
- Return discoverable schema metadata for query planning.

Expected output:
- Allowed tables/views
- Allowed columns
- Basic constraints and examples

### 4.2 `db_read`
Purpose:
- Execute one read-only SQL query with strict runtime control.

Input:
- `sql: string`
- `params?: Record<string, string | number | boolean | null>` (caller-optional; runtime materializes params object and injects `group_id` before execution)

Output (structured):
- `columns: string[]`
- `rows: unknown[][]`
- `rowCount: number`
- `truncated: boolean`
- `elapsedMs: number`
- optional `error` object when rejected/failed

### 4.3 `web_search`
Purpose:
- Retrieve external knowledge when group history is insufficient.

Input:
- `query: string`
- optional `maxResults?: number` (runtime-capped)

Output normalization requirement:
- Keep a predictable, structured result shape (title/url/snippet style).

### 4.4 `final_answer`
Purpose:
- Sole formal completion protocol for final user-facing text.

Constraint:
- Payload shape is fixed to `{ text: string }` (plain text only).
- Runtime truncates final text to configured maximum.

## 5. SQL Guardrails (`db_read`)

This is mandatory for v1.

1. Read-only statement class only
- Allow only `SELECT` and `WITH ... SELECT` single statement.
- Reject DDL/DML and dangerous keywords.

2. Group scope hard boundary
- Contract (single source of truth):
  - SQL must include `:group_id` parameter.
  - SQL must contain an explicit group filter predicate bound to `:group_id` (for example `group_id = :group_id`).
  - Runtime injects the concrete current-group value into `params.group_id`.
  - Runtime does not rewrite SQL for group scoping; missing/invalid scope is rejected.
  - Accepted predicate forms for v1 validator:
    - `group_id = :group_id`
    - `<table_or_alias>.group_id = :group_id`

3. Runtime limits
- Statement timeout.
- Max rows.
- Max output characters/bytes.

4. Failure semantics
- Return structured errors to model; do not crash loop for recoverable failures.

## 6. Agent Loop Behavior

## 6.1 Initialization

Seed history (minimal but useful):
- Trigger message text.
- One-level quoted context if present.
- Latest 20 group messages.
- Time and system boundary instructions.

Principle:
- "Minimal seed by host, context expansion by agent."

## 6.2 Iteration

Per step:
1. Model produces tool calls or final answer.
2. Runtime executes tools in declared order.
3. Tool results appended to history.
4. Next step continues until termination.

## 6.3 Termination and fallback

Normal:
- `final_answer`

Abnormal:
- max steps exceeded
- global timeout
- adapter/system fatal error

Fallback:
- drop to existing single-turn reply path.

## 7. Data Flow

1. Input phase
- Receive `@` event and build minimal seed context.

2. Planning phase
- Agent decides retrieval strategy dynamically.

3. Retrieval phase
- `db_read` for in-group evidence.
- `web_search` for external evidence.

4. Synthesis phase
- Agent combines evidence via iterative history.
- Completes with `final_answer`.

## 8. Error Handling And Observability

Required trace fields per run:
- run state (`final/fallback/aborted`)
- termination type
- total duration
- step count
- per-step tool name
- per-step duration
- tool error details (if any)
- row/result truncation indicators

Operational metrics (v1 acceptance):
- final-answer success rate
- fallback rate
- timeout rate
- guardrail rejection rate
- max-steps abort rate
- P50/P95/P99 latency

Quantitative target thresholds (for rollout gate):
- `final_answer` termination rate >= 90%
- fallback rate <= 15%
- timeout rate <= 5%
- max-steps abort rate <= 8%
- cross-group leakage incidents = 0
- P95 end-to-end latency <= 18s
- P99 end-to-end latency <= 30s
- average input tokens per run <= 12,000

Metric denominator definition:
- Unless otherwise stated, percentages are computed over `agent-started runs` (runs that entered the new agent loop), not all inbound `@` events.

## 9. Prioritized Delivery Scope

### P0 (must-have)
1. Replace `@` main path with new agent loop.
2. Ship atomic tool set (`db_schema`, `db_read`, `web_search`, `final_answer`).
3. Implement SQL guardrails.
4. Seed context with latest 20 messages.
5. Keep full run/step trace logs.
6. Keep single-turn fallback.

### P1 (next)
1. Add `fetch_url` as second-hop web evidence tool.
2. Improve `db_schema` with examples/annotations.
3. Improve tool result channel as "structured + preview text" dual form.
4. Add monitoring views for steps/latency/fallback.

Planning note:
- The immediate implementation plan should target P0 only. P1 remains backlog for the next cycle.

### Deferred (intentionally not planned now)
- P2 items (memory dual-track redesign, planner/executor split, advanced DB isolation) are postponed.

## 10. Memory Strategy For Now

Current decision:
- Memory is non-blocking for v1.
- No memory redesign is required before launching the new online retrieval architecture.

Future direction (not scheduled now):
- Potential dual-track memory:
  - structured facts in DB
  - narrative summaries in files
- Access by retrieval tools only, not full prompt injection.

## 11. OpenClaw-Inspired Design Principles (Adapted)

The following principles are derived from broad open-source agent practices and validated against OpenClaw's architecture:

1. Runtime and context management should be decoupled.
2. Tool freedom must be paired with hard runtime policy enforcement.
3. Hook points (`before_tool_call` style) are critical for non-breaking evolution.
4. Context growth must be governed (truncation, overflow recovery, compaction-ready interfaces).
5. Memory should be retrieval-first (on-demand), not always-injected.
6. Queueing should be session-serialized to avoid race-induced context corruption.
7. Observability must be designed in from day one.

This section is guidance, not a separate implementation scope gate for v1 delivery.

## 12. Acceptance Criteria (Experiment Phase)

Functionality:
- Agent can solve representative "group history + web" questions without old high-level tools.

Capability:
- Multi-step chains occur naturally (e.g., `db_read -> web_search -> final_answer`).

Safety:
- No cross-group leakage events.
- No write-capable DB execution.

Stability:
- fallback rate <= 15%
- timeout rate <= 5%
- max-steps abort rate <= 8%

Performance:
- P95 end-to-end latency <= 18s
- P99 end-to-end latency <= 30s
- average input tokens per run <= 12,000

Exit condition for v1.1 planning:
- Observe for 3-7 days with at least 300 `@` runs.
- If all quantitative gates above pass, proceed to next iteration scope.

## 13. Mapping To Existing Repo Modules

Planned change surfaces:
- `src/agent/types.ts` (tool/result contract refinements)
- `src/agent/tools.ts` (atomic tools + guardrails)
- `src/agent/loop.ts` (step behavior + structured results handling)
- `src/agent/openai-agent-adapter.ts` (or renamed generic adapter)
- `src/responder/handlers/at-mention.ts` (direct route to new architecture)

Non-goal for this phase:
- Do not implement memory redesign in this delivery.
