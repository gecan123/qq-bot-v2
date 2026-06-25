# Tool Hooks Design

## Goal

Add a small tool hook pipeline as the first step toward the `learn-claude-code` harness route, without changing current tool behavior, prompt bytes, replay, or `AgentContext` serialization.

## Decision

Introduce hook support inside `createToolExecutor`, not inside `BotLoopAgent`.

The executor is already the single boundary where LLM tool calls become side effects. Keeping hooks there gives later permission checks, metrics, background dispatch, and MCP policy one stable attachment point while preserving the core agent loop.

## Scope

First slice:

- Add `beforeTool` and `afterTool` executor hooks.
- Let `beforeTool` return a blocking `ToolExecutionResult`.
- Always trace hook-blocked calls through the existing tool-call log.
- Keep schema normalization and validation before policy hooks, so hook code sees parsed, normalized args.
- Keep existing tool implementations unchanged.

Out of scope for this slice:

- No new user-facing tool.
- No task system.
- No cron scheduler.
- No MCP runtime.
- No subagent/team/worktree behavior.
- No system prompt text changes.

## Data Flow

Current flow:

```text
LLM tool call
  -> find tool
  -> normalize args
  -> validate args
  -> execute tool
  -> trace result
  -> append tool result to AgentContext
```

New flow:

```text
LLM tool call
  -> find tool
  -> normalize args
  -> validate args
  -> beforeTool hooks
       -> optional blocked tool result
  -> execute tool when not blocked
  -> afterTool hooks
  -> trace final result
  -> append tool result to AgentContext
```

The result that enters `AgentContext` remains a normal tool result paired to the original assistant tool call id.

## Hook Shape

Use a minimal typed interface:

```ts
export interface ToolHookContext extends ToolContext {
  tool: Tool
  call: AssistantToolCall
}

export type BeforeToolHook = (
  ctx: ToolHookContext,
) => Promise<ToolExecutionResult | void> | ToolExecutionResult | void

export type AfterToolHook = (
  ctx: ToolHookContext & { result: ToolExecutionResult },
) => Promise<void> | void
```

Executor options get:

```ts
hooks?: {
  beforeTool?: BeforeToolHook[]
  afterTool?: AfterToolHook[]
}
```

## Error Handling

- If a `beforeTool` hook throws, return `{ error: "Tool hook failed: ..." }` and trace failure.
- If a `beforeTool` hook returns a result, skip tool execution and trace the returned result as a normal completed call.
- If an `afterTool` hook throws, preserve the original tool result, trace the hook failure as metadata if possible, and log a warning. Do not turn a successful side effect into a retryable tool failure after it may already have happened.

## Permission Direction

The first real policy hook should be an internal `createToolPolicyHook`, not another check inside `BotLoopAgent`.

Initial policy candidates:

- `workspace_bash cwd=repo` must remain read-only.
- `send_message` target validation stays in the tool, because it needs sender-specific behavior.
- Browser high-risk actions remain in browser protocol/risk code for now.
- Future MCP destructive annotations can be handled in the shared hook.

This avoids duplicating policy in both tool schemas and the loop.

## Testing

Focused tests should cover:

- `beforeTool` can block execution and returns its own result.
- blocked calls are traced once with normalized args.
- `beforeTool` receives normalized args, not raw nullable optional fields.
- hook throws become structured tool errors.
- `afterTool` runs after successful tool execution.
- `afterTool` failure does not discard the original tool result.

## Verification

Run focused tests first:

```bash
pnpm exec tsx --test --import tsx src/agent/tool.test.ts
```

Then run:

```bash
pnpm typecheck
pnpm repo-check
```

Because this changes executor plumbing, broad `pnpm test` is useful before merging if the worktree is clean enough.
