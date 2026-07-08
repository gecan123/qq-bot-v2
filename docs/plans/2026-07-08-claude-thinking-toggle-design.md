# Claude Thinking Toggle Design

## Goal

Add an experimental Claude thinking path that can be enabled with feature toggles, logs raw thinking for debugging, and keeps prompt history stable by retaining thinking blocks only while their tool cycle is active by default.

## Background

The current Claude Code-compatible path does not send a `thinking` field. The request builder only serializes user text, assistant text, assistant `tool_use`, and `tool_result` blocks. The SSE parser and `LlmCallOutput` also drop all non-text and non-tool blocks.

Kagami currently handles the same risk by explicitly sending `thinking: { type: "disabled" }`. Its comment says the message model and persistence do not recognize thinking blocks, and dropping them during tool replay can cause Anthropic API errors.

## Toggles

Add these environment variables:

- `LLM_PROVIDER_CLAUDE_THINKING=disabled|adaptive`
  - Default: `disabled`.
  - `adaptive` sends `thinking: { type: "adaptive", display: "summarized" }` unless a later implementation deliberately chooses omitted display.
- `LLM_PROVIDER_CLAUDE_THINKING_PROMPT_RETENTION=active-tool-cycle|always`
  - Default: `active-tool-cycle`.
  - `active-tool-cycle` keeps thinking blocks in prompt replay only until the related `tool_use` has received its `tool_result`.
  - `always` keeps thinking blocks in prompt replay for observation and cache/context experiments.
- `LLM_PROVIDER_CLAUDE_THINKING_LOG=off|summary|raw`
  - Default: `off`.
  - `raw` writes thinking blocks to `logs/claude-thinking.ndjson`.
  - `summary` writes only size, block ids, signatures presence, and neighboring tool call ids.

When thinking is enabled with tools, Claude `tool_choice` must be `auto`; `any` and forced `tool` are incompatible with extended thinking tool use.

## Data Model

Do not treat thinking as assistant text. Add a provider-native assistant block lane to the persisted LLM ledger so replay can preserve Anthropic block order:

```ts
type AssistantNativeBlock =
  | { type: 'thinking'; thinking?: string; signature?: string; [key: string]: unknown }
  | { type: 'redacted_thinking'; data?: string; [key: string]: unknown }

type AgentMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string
      toolCalls: AssistantToolCall[]
      nativeBlocks?: AssistantNativeBlock[]
    }
  | { role: 'tool'; toolCallId: string; content: ToolResultContent }
```

`nativeBlocks` is optional so existing snapshots remain readable. Increment snapshot schema only if validation or migration code requires it; otherwise keep this as a backward-compatible extension.

## Prompt Retention

Default retention is `active-tool-cycle`:

1. If an assistant turn contains `thinking + tool_use`, persist the native thinking block and log it according to `LLM_PROVIDER_CLAUDE_THINKING_LOG`.
2. On the next request that sends the matching `tool_result`, replay the thinking block before its associated `tool_use`.
3. Once every tool call in that assistant turn has a following tool result, strip the thinking block from subsequent prompt replay.
4. Keep the raw thinking in the persisted snapshot only if needed for audit/debug. It must not be reintroduced into prompt history after the tool cycle closes.

`always` skips step 3 and replays all persisted thinking blocks.

## Parser And Logging

The Claude SSE parser must recognize thinking blocks and preserve their final block shape. The parser should not expose thinking as normal `content`; it should return it as native blocks.

`raw` logging writes one NDJSON line per thinking block:

```json
{"ts":"...","roundIndex":12,"model":"claude-sonnet-4-6","blockIndex":0,"type":"thinking","text":"...","signature":"...","toolCallIds":["toolu_..."]}
```

Logs are operational artifacts only. Replay must use `AgentContext`, never logs.

## Cache And Compaction

Prompt cache prefix stability depends on deterministic replay:

- Do not modify thinking blocks while they are active.
- Do not mark thinking blocks with `cache_control`; keep cache breakpoints on system/message cacheable blocks.
- Keep thinking configuration stable for a process; changing thinking mode or effort invalidates message cache breakpoints.
- Compaction must not split `thinking + tool_use + tool_result` while the tool cycle is active.
- After compaction, thinking must not be emitted as native thinking. It can be dropped or represented as ordinary summary text.

## Tests

Focused tests should cover:

- Config parsing defaults and invalid values.
- Request body adds `thinking` only when enabled.
- Thinking enabled forces or validates Claude `tool_choice=auto`.
- SSE parser preserves thinking blocks and signatures.
- `active-tool-cycle` replay includes thinking before the matching tool result, then strips it after closure.
- `always` replay keeps thinking after closure.
- Raw logging writes thinking to NDJSON without using logs for replay.

## Non-Goals

- No server-side compaction or context editing integration.
- No UI for reading thinking logs.
- No attempt to expose thinking to QQ users.
- No support for non-Claude providers.
