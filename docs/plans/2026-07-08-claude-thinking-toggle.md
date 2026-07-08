# Claude Thinking Toggle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an experimental Claude thinking toggle with raw thinking debug logs and prompt replay retention that defaults to active tool cycles only.

**Architecture:** Extend config first, then carry provider-native Claude thinking blocks through parsing, LLM output, `AgentContext`, and Claude request replay. Keep default behavior unchanged by leaving thinking disabled unless the new env flag is set.

**Tech Stack:** TypeScript, Node test runner, ESM imports with `.js` extensions, Anthropic Messages wire format, existing `AgentContext` snapshot persistence.

---

### Task 1: Parse Thinking Toggles

**Files:**
- Modify: `src/config/index.ts`
- Test: `src/config/index.test.ts`
- Docs: `.env.example`

**Step 1: Write the failing config tests**

Add tests that assert:

```ts
const config = parseConfig(createBaseEnv())
assert.deepEqual(config.llm.claudeThinking, {
  mode: 'disabled',
  retention: 'active-tool-cycle',
  log: 'off',
})
```

Add another test with:

```ts
const config = parseConfig({
  ...createBaseEnv(),
  LLM_PROVIDER_CLAUDE_THINKING: 'adaptive',
  LLM_PROVIDER_CLAUDE_THINKING_PROMPT_RETENTION: 'always',
  LLM_PROVIDER_CLAUDE_THINKING_LOG: 'raw',
})
assert.deepEqual(config.llm.claudeThinking, {
  mode: 'adaptive',
  retention: 'always',
  log: 'raw',
})
```

Add invalid value assertions for each new env var.

**Step 2: Run the failing test**

Run:

```bash
pnpm exec tsx --test --import tsx src/config/index.test.ts
```

Expected: FAIL because `config.llm.claudeThinking` does not exist.

**Step 3: Implement config parsing**

Add narrow parser helpers:

```ts
type ClaudeThinkingMode = 'disabled' | 'adaptive'
type ClaudeThinkingRetention = 'active-tool-cycle' | 'always'
type ClaudeThinkingLog = 'off' | 'summary' | 'raw'
```

Expose:

```ts
claudeThinking: {
  mode: ClaudeThinkingMode
  retention: ClaudeThinkingRetention
  log: ClaudeThinkingLog
}
```

**Step 4: Run the test**

Run the same command. Expected: PASS.

**Step 5: Update `.env.example`**

Document defaults:

```env
LLM_PROVIDER_CLAUDE_THINKING=disabled
LLM_PROVIDER_CLAUDE_THINKING_PROMPT_RETENTION=active-tool-cycle
LLM_PROVIDER_CLAUDE_THINKING_LOG=off
```

### Task 2: Add Claude Native Block Types

**Files:**
- Modify: `src/agent/agent-context.types.ts`
- Modify: `src/agent/llm-client.ts`
- Test: `src/agent/agent-context.test.ts` or closest existing context test

**Step 1: Write the failing type/behavior test**

Add a test that appends an assistant turn with:

```ts
nativeBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }]
```

Then assert `getSnapshot()` returns the same block byte-for-byte.

**Step 2: Run focused context test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/agent-context.test.ts
```

Expected: FAIL because assistant turns do not accept/preserve `nativeBlocks`.

**Step 3: Implement minimal type support**

Add:

```ts
export type ClaudeAssistantNativeBlock =
  | { type: 'thinking'; thinking?: string; signature?: string; [key: string]: unknown }
  | { type: 'redacted_thinking'; data?: string; [key: string]: unknown }
```

Extend assistant `AgentMessage` and `LlmCallOutput` with optional native blocks.

**Step 4: Run focused context test**

Expected: PASS.

### Task 3: Parse Thinking Blocks From Claude SSE

**Files:**
- Modify: `src/agent/claude-code/sse-parser.ts`
- Test: `src/agent/claude-code/sse-parser.test.ts`

**Step 1: Write failing parser test**

Add an SSE stream containing:

```json
{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":"sig"}}
{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step"}}
{"type":"content_block_stop","index":0}
```

Assert parsed content includes:

```ts
{ type: 'thinking', thinking: 'step', signature: 'sig' }
```

**Step 2: Run parser test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/claude-code/sse-parser.test.ts
```

Expected: FAIL because thinking blocks are ignored.

**Step 3: Implement parser support**

Add a `thinking` stream block kind. Accumulate `thinking_delta.thinking`, preserve `signature`, and pass through `redacted_thinking` blocks without inventing text.

**Step 4: Run parser test**

Expected: PASS.

### Task 4: Map Thinking To LLM Output And Debug Logs

**Files:**
- Modify: `src/agent/claude-code/llm-client.ts`
- Create: `src/agent/claude-code/thinking-log.ts`
- Test: `src/agent/claude-code/llm-client.test.ts`

**Step 1: Write failing mapping/log test**

Set the client thinking log mode to `raw`, return a Claude response with one thinking block and one tool use, then assert:

- `LlmCallOutput.nativeBlocks` contains the thinking block.
- `content` does not include thinking text.
- the test log sink receives one NDJSON-shaped entry.

**Step 2: Run focused client test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/claude-code/llm-client.test.ts
```

Expected: FAIL because thinking blocks are not mapped or logged.

**Step 3: Implement minimal mapping and logger**

Keep existing text/tool mapping. Add native block extraction. Implement `appendClaudeThinkingLog` with `fs.promises.appendFile`, best-effort warning on failure, and no replay dependency.

**Step 4: Run focused client test**

Expected: PASS.

### Task 5: Send Thinking Request Body Only When Enabled

**Files:**
- Modify: `src/agent/claude-code/request.ts`
- Modify: `src/agent/claude-code/llm-client.ts`
- Modify: `src/agent/llm-client.ts`
- Test: `src/agent/claude-code/request.test.ts`
- Test: `src/agent/claude-code/llm-client.test.ts`

**Step 1: Write failing request tests**

Assert default request has no `thinking` field or has explicit disabled only if the implementation chooses Kagami-compatible explicit disable.

Assert adaptive mode request includes:

```ts
thinking: { type: 'adaptive', display: 'summarized' }
```

Assert adaptive mode with tools uses `tool_choice: { type: 'auto' }`.

**Step 2: Run request tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/claude-code/request.test.ts
```

Expected: FAIL because request builder has no thinking input.

**Step 3: Implement request support**

Add `thinkingMode` to `BuildClaudeCodeRequestBodyInput`. When enabled, include adaptive thinking and force/validate `tool_choice=auto`.

**Step 4: Thread config into client factory**

Pass `config.llm.claudeThinking` through `createLlmClient` to `createClaudeCodeLlmClient`.

**Step 5: Run request and client tests**

Expected: PASS.

### Task 6: Replay Active Tool Cycle Thinking

**Files:**
- Modify: `src/agent/react-kernel.ts`
- Modify: `src/agent/claude-code/request.ts`
- Test: `src/agent/react-kernel.test.ts`
- Test: `src/agent/claude-code/request.test.ts`

**Step 1: Write failing React kernel test**

Use a fake LLM completion with:

```ts
nativeBlocks: [{ type: 'thinking', thinking: 'step', signature: 'sig' }],
toolCalls: [{ id: 'toolu_1', name: 'wait', args: {} }]
```

Assert the appended assistant turn includes the native thinking block.

**Step 2: Run React kernel test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/react-kernel.test.ts
```

Expected: FAIL because native blocks are not appended.

**Step 3: Implement append support**

When appending assistant tool turns, include `completion.nativeBlocks`.

**Step 4: Write failing request replay test**

Create messages:

```ts
assistant(nativeBlocks=[thinking], toolCalls=[toolu_1])
tool(toolCallId='toolu_1')
user('next')
```

With retention `active-tool-cycle`, assert thinking is present in the assistant content for the tool-result replay request but absent after the cycle is closed and a later request is rendered.

**Step 5: Implement retention filtering**

In Claude request rendering, include native thinking blocks for assistant turns only when:

- retention is `always`, or
- the assistant turn has a tool call that does not yet have a matching following tool result at the point being rendered for tool-result continuation.

Keep block order: native thinking blocks before `tool_use` blocks.

**Step 6: Run focused tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/react-kernel.test.ts src/agent/claude-code/request.test.ts
```

Expected: PASS.

### Task 7: Compaction Guard

**Files:**
- Modify: `src/agent/compaction.ts`
- Test: `src/agent/compaction.test.ts`

**Step 1: Write failing compaction test**

Create a history with `assistant(nativeBlocks=[thinking], toolCalls=[toolu_1])` followed by its `tool` result. Assert compaction does not leave an assistant turn with native thinking separated from its tool result.

**Step 2: Run compaction test**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/compaction.test.ts
```

Expected: FAIL if compaction can split or preserve thinking incorrectly.

**Step 3: Implement guard**

Before compaction rewrites prefix history, strip native thinking from compacted assistant messages unless the corresponding tool cycle remains intact in the un-compacted suffix.

**Step 4: Run compaction test**

Expected: PASS.

### Task 8: Final Verification And Docs

**Files:**
- Modify: `docs/AGENT_CONTEXT.md`
- Modify: `docs/TOOLS.md` if provider behavior notes need updating

**Step 1: Update docs**

Add a short note that Claude thinking is experimental, controlled by env toggles, logs are operational artifacts, and replay source remains `AgentContext`.

**Step 2: Run focused suite**

Run:

```bash
pnpm exec tsx --test --import tsx \
  src/config/index.test.ts \
  src/agent/claude-code/request.test.ts \
  src/agent/claude-code/sse-parser.test.ts \
  src/agent/claude-code/llm-client.test.ts \
  src/agent/react-kernel.test.ts \
  src/agent/compaction.test.ts
```

Expected: PASS.

**Step 3: Run broad static checks**

Run:

```bash
pnpm typecheck
pnpm repo-check
```

Expected: PASS.

**Step 4: Commit**

```bash
git add .env.example docs/AGENT_CONTEXT.md docs/TOOLS.md src/config/index.ts src/config/index.test.ts src/agent/agent-context.types.ts src/agent/agent-context.test.ts src/agent/llm-client.ts src/agent/claude-code/request.ts src/agent/claude-code/request.test.ts src/agent/claude-code/sse-parser.ts src/agent/claude-code/sse-parser.test.ts src/agent/claude-code/llm-client.ts src/agent/claude-code/llm-client.test.ts src/agent/claude-code/thinking-log.ts src/agent/react-kernel.ts src/agent/react-kernel.test.ts src/agent/compaction.ts src/agent/compaction.test.ts
git commit -m "feat: 增加 Claude thinking 实验开关"
```
