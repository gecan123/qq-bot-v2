# Tool Policy Hook Design

## Goal

Build phase 2 of the harness route: add a thin internal policy hook on top of the phase 1 tool hook pipeline, without changing user-visible tool behavior, system prompt bytes, replay, or `AgentContext`.

## Decision

Create a small `createToolPolicyHook()` in `src/agent/tool-policy.ts` and attach it as a `beforeTool` hook in `src/index.ts`.

The hook is not a full permission system. It is the shared place for mechanical tool-call policy that is independent of individual tool implementation details. Existing specialized checks stay where they are.

## Scope

Phase 2 includes:

- Add `src/agent/tool-policy.ts`.
- Add focused tests in `src/agent/tool-policy.test.ts`.
- Wire the policy hook into `createToolExecutor` in `src/index.ts`.
- Keep all current built-in tool calls allowed by default.
- Add a conservative block path for tools that declare explicit destructive metadata through an internal optional `policy` field.

Phase 2 does not include:

- No user approval UI or owner approval flow.
- No task system.
- No cron scheduler.
- No MCP runtime.
- No subagent/team/worktree behavior.
- No system prompt or tool description changes.
- No migration of existing `send_message`, `browser`, or `workspace_bash` validation logic.

## Why This Shape

The current code already enforces important boundaries inside specific tools:

- `send_message` validates explicit targets and ambient group send rules.
- `workspace_bash` parses an allowlisted command subset and keeps repo mode read-only.
- `browser` delegates high-risk actions to browser protocol/risk code.
- Tool call audit is already centralized in `createToolExecutor`.

Duplicating these checks in phase 2 would create drift. The better move is to establish a stable shared policy attachment point, then let later phases reuse it for MCP destructive annotations, background dispatch decisions, or owner approval.

## Tool Metadata

Add an optional internal field to `Tool`:

```ts
policy?: {
  effect?: 'read' | 'write' | 'external' | 'destructive'
  requiresApproval?: boolean
}
```

This is not sent to the LLM. Existing request builders only serialize `name`, `description`, and schema, and tests should protect that.

Initial interpretation:

- missing `policy`: allow
- `effect: 'read'`: allow
- `effect: 'write'`: allow for now; auditing already marks side effects
- `effect: 'external'`: allow for now
- `effect: 'destructive'`: block unless future config explicitly allows it
- `requiresApproval: true`: block in phase 2, because no approval channel exists yet

## Block Result

Blocked calls return a normal tool result:

```json
{
  "ok": false,
  "error": "Tool call blocked by policy",
  "reason": "approval_required",
  "toolName": "dangerous_tool"
}
```

The result is paired to the original assistant tool call id by `BotLoopAgent`, exactly like any other tool result. The tool itself is not executed.

## Data Flow

```text
LLM tool call
  -> createToolExecutor
  -> normalize args
  -> validate schema
  -> createToolPolicyHook beforeTool
       -> allow, or return blocked tool result
  -> execute tool if allowed
  -> trace final result
  -> append tool result to AgentContext
```

## Error Handling

- The policy hook should not throw for ordinary malformed policy metadata.
- If policy metadata is internally inconsistent, fail closed with a blocked result.
- Existing phase 1 hook error handling remains the last-resort guard.

## Testing

Focused tests should prove:

- Missing policy metadata allows execution.
- `effect: 'read'`, `'write'`, and `'external'` allow execution.
- `effect: 'destructive'` blocks execution.
- `requiresApproval: true` blocks execution.
- Blocked results are structured JSON with `ok:false`.
- Wiring in `src/index.ts` preserves existing executor trace config.
- Tool schemas sent to LLM do not expose the internal `policy` field.

## Verification

Use the same test env required by broad tests:

```bash
DATABASE_URL='postgresql://user:pass@localhost:5432/db' \
NAPCAT_WS_URL='ws://localhost:3001' \
NAPCAT_ACCESS_TOKEN='token' \
BOT_TARGET_GROUP_IDS='123' \
SELF_NUMBER='789' \
LLM_DEFAULT_PROVIDER='claude-code' \
LLM_DEFAULT_MODEL='claude-sonnet-4-6' \
LLM_PROVIDER_CLAUDE_URL='http://127.0.0.1:8317/v1' \
LLM_PROVIDER_CLAUDE_API_KEY='sk-local' \
LLM_PROVIDER_OPENAI_URL='http://127.0.0.1:8317/v1' \
LLM_PROVIDER_OPENAI_API_KEY='sk-local' \
pnpm test
```

Also run:

```bash
pnpm typecheck
pnpm repo-check
```
