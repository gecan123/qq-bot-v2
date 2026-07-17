# Claude Cache-Preserving Compaction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Claude compaction reuse the main Agent's cached prompt prefix while preserving the existing append-only ledger, cut boundary, recent tail, validation, and replay behavior.

**Architecture:** Add provider-only message cache-breakpoint metadata to the existing LLM request contract, compute a future compaction breakpoint from the same atomic history rules used by compaction, and let the Claude summarizer reuse the main system, visible tools, thinking configuration, and original working-context prefix. OpenAI and the existing durable compaction payload remain unchanged.

**Tech Stack:** TypeScript ESM, Node test runner, Anthropic Messages-compatible transport, OpenAI Chat Completions fallback, Prisma-backed append-only ledger.

---

### Task 1: Share message token and atomic cut logic

**Files:**
- Modify: `src/agent/compaction-token-estimator.ts`
- Modify: `src/agent/compaction.ts`
- Test: `src/agent/compaction.test.ts`

**Step 1: Write the failing boundary test**

Add tests for a new pure helper such as:

```ts
selectCompactionCacheBreakpointMessageIndex(messages, keepRecentTokens)
```

The tests must show that it:

- returns the last message index before the recent tail;
- prefers the same user boundary as `prepareCompaction`;
- never returns an index between an assistant tool call and its ordered tool results;
- returns `null` when there is no legal cut.

**Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm test -- src/agent/compaction.test.ts
```

Expected: FAIL because the message-index helper does not exist.

**Step 3: Implement the shared pure logic**

Export a message-level token estimator from `compaction-token-estimator.ts`. Refactor the existing compaction atomic-unit builder and boundary selector so both canonical ledger preparation and provider-only cache planning call the same implementation. Keep ledger IDs and messages as caller-specific wrappers; do not duplicate the tool-pair algorithm.

The cache helper returns the final message index of the summarized prefix, not `firstKeptEntryId`.

**Step 4: Run the focused tests and verify GREEN**

Run:

```bash
pnpm test -- src/agent/compaction.test.ts src/agent/compaction-token-estimator.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/compaction.ts src/agent/compaction-token-estimator.ts src/agent/compaction.test.ts src/agent/compaction-token-estimator.test.ts
git commit -m "refactor: 复用压缩原子切点逻辑"
```

### Task 2: Support an additional Claude message breakpoint

**Files:**
- Modify: `src/agent/llm-client.ts`
- Modify: `src/agent/claude-code/request.ts`
- Modify: `src/agent/claude-code/llm-client.ts`
- Test: `src/agent/claude-code/request.test.ts`
- Test: `src/agent/claude-code/llm-client.test.ts`
- Test: `src/agent/openai-agent/llm-client.test.ts`

**Step 1: Write failing request-shape tests**

Extend `LlmCallInput` and `BuildClaudeCodeRequestBodyInput` with optional provider cache metadata:

```ts
cacheBreakpointMessageIndexes?: readonly number[]
```

Test that Claude request construction:

- puts `cache_control: {type:'ephemeral', ttl:'1h'}` on the last content block produced by each requested source message index;
- still puts the existing breakpoint on the final request message;
- deduplicates when the future cut is already the final message;
- ignores negative, out-of-range, or source messages that render to no Claude block;
- does not reorder tools, system, messages, thinking, or tool choice.

Add a regression test showing OpenAI request JSON is unchanged when the metadata is present.

**Step 2: Run provider tests and verify RED**

Run:

```bash
pnpm test -- src/agent/claude-code/request.test.ts src/agent/claude-code/llm-client.test.ts src/agent/openai-agent/llm-client.test.ts
```

Expected: FAIL because the cache metadata is not accepted or forwarded.

**Step 3: Implement minimal request mapping**

Build Claude messages source-by-source instead of losing the source index in a single `flatMap`. Attach an extra breakpoint only to the last emitted content block for a selected source message. Keep the system breakpoint and final-message breakpoint exactly as today.

Forward the optional field through `createClaudeCodeLlmClient`. Ignore it in `openai-agent` so the OpenAI wire request remains byte-compatible.

**Step 4: Run provider tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/llm-client.ts src/agent/claude-code/request.ts src/agent/claude-code/request.test.ts src/agent/claude-code/llm-client.ts src/agent/claude-code/llm-client.test.ts src/agent/openai-agent/llm-client.test.ts
git commit -m "feat: 支持 Claude 压缩缓存断点"
```

### Task 3: Write the future cut during normal main-Agent calls

**Files:**
- Modify: `src/agent/react-kernel.ts`
- Modify: `src/agent/bot-loop-agent.ts`
- Test: `src/agent/react-kernel.test.ts`
- Test: `src/agent/bot-loop-agent.test.ts`

**Step 1: Write the failing kernel test**

Add an optional `compactionCacheKeepRecentTokens` input to `runReactRound`. Test with a recording `LlmClient` that the kernel passes exactly one future-cut message index plus the provider's existing implicit final breakpoint behavior. Test an assistant tool call/result group at the cut.

Add a host regression test showing `BotLoopAgent` passes configured `keepRecentTokens` into every main round without changing staged-message or overflow behavior.

**Step 2: Run tests and verify RED**

```bash
pnpm test -- src/agent/react-kernel.test.ts src/agent/bot-loop-agent.test.ts
```

Expected: FAIL because the kernel does not calculate or forward a future cut.

**Step 3: Implement minimal wiring**

After constructing the disposable working-context messages, call the Task 1 helper. When it returns an index, pass it as `cacheBreakpointMessageIndexes`. Do not persist the index, marker, or provider cache metadata in `AgentContext` or the ledger.

Have `BotLoopAgent` pass `compactOptions.keepRecentTokens ?? config.compaction.keepRecentTokens` into `runReactRound`.

**Step 4: Run tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/react-kernel.ts src/agent/react-kernel.test.ts src/agent/bot-loop-agent.ts src/agent/bot-loop-agent.test.ts
git commit -m "feat: 预热 Claude 压缩前缀缓存"
```

### Task 4: Build a cache-preserving Claude summarizer

**Files:**
- Modify: `src/agent/compaction-serialization.ts`
- Modify: `src/agent/compaction.ts`
- Test: `src/agent/compaction-serialization.test.ts`
- Test: `src/agent/compaction.test.ts`

**Step 1: Write failing summarizer tests**

Add a stable control-message renderer for Claude history compaction. Test that it:

- repeats the existing seven required headings and output budget contract;
- states that the raw prefix will be replaced and future work must continue from the summary;
- tells Claude to return text only and never call tools;
- keeps manual owner focus in trusted control text;
- tells Claude not to convert controlled machine-state markers into authoritative summary state.

Add a recording-LLM test for a cache-preserving summarizer function. Assert that it sends the supplied main system prompt, original working-context prefix, and visible tools unchanged, then appends exactly one control message.

Add failure tests for tool calls, empty content, `max_tokens`, context-window stop, and cancellation. None may return a usable summary.

**Step 2: Run tests and verify RED**

```bash
pnpm test -- src/agent/compaction-serialization.test.ts src/agent/compaction.test.ts
```

Expected: FAIL because the control renderer and cache-preserving summarizer do not exist.

**Step 3: Implement the summarizer**

Create a helper with an explicit input contract similar to:

```ts
summarizeCachedClaudeCompaction({
  llm,
  systemPrompt,
  messages,
  tools,
  manualFocus,
  signal,
})
```

It calls the already-constructed main `LlmClient`, records `operation='compaction'` token usage, never invokes returned tools, and returns only validated non-empty plain text to the existing candidate validator.

Keep `buildCompactionSummarizerRequest()` unchanged for OpenAI and the rare split-turn prefix fallback.

**Step 4: Run tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/compaction-serialization.ts src/agent/compaction-serialization.test.ts src/agent/compaction.ts src/agent/compaction.test.ts
git commit -m "feat: 使用主前缀生成 Claude 压缩摘要"
```

### Task 5: Integrate provider selection without changing OpenAI

**Files:**
- Modify: `src/agent/bot-loop-agent.ts`
- Modify: `src/agent/working-context.ts` only if a small reusable projection helper is required
- Test: `src/agent/bot-loop-agent.test.ts`
- Test: `src/agent/working-context.test.ts` if modified

**Step 1: Write failing integration tests**

Add a Claude-path compaction test asserting:

- the history summary uses the current projected main prefix through `preparation.historyEntries`;
- prior compaction summary and deterministic machine-state messages retain their main-request bytes;
- visible tools come from the same `ToolExecutor.list()` result as a main round;
- the resulting summary still commits through the existing compaction payload and boundary;
- a returned tool call leaves the ledger unchanged and activates existing failure backoff.

Add an OpenAI-path regression test asserting it still receives the dedicated compaction system plus `[UNTRUSTED_DATA]` envelopes and `tools: []`.

Add a split-turn regression showing the main history pass uses cached Claude prefix while the special split-turn-prefix pass retains the existing bounded legacy serializer.

**Step 2: Run tests and verify RED**

```bash
pnpm test -- src/agent/bot-loop-agent.test.ts src/agent/working-context.test.ts
```

Expected: FAIL because the host always uses the legacy summarizer.

**Step 3: Implement host selection**

When the configured provider is `claude-code` and no test/custom summarizer override is supplied:

1. Build the same disposable working-context projection used by the main round.
2. Calculate the synthetic prefix count as projected messages minus active canonical messages.
3. Slice through the end of `preparation.historyEntries` so the request includes prior summary and controlled projection bytes before the canonical history prefix.
4. Call the cache-preserving Claude summarizer with `deps.systemPrompt`, `deps.tools.list()`, and the existing `deps.llm`.
5. For `kind='split_turn_prefix'`, keep the existing legacy summarizer path.

When the provider is OpenAI, or `compactOptions.summarizeCandidate` is explicitly supplied, preserve current behavior exactly.

**Step 4: Run tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/bot-loop-agent.ts src/agent/bot-loop-agent.test.ts src/agent/working-context.ts src/agent/working-context.test.ts
git commit -m "feat: 接入 Claude 缓存复用压缩"
```

### Task 6: Document and verify the complete contract

**Files:**
- Modify: `docs/AGENT_CONTEXT.md`
- Modify: `docs/TOOLS.md`
- Modify: `docs/TECH_DEBT.md` only if observability gaps remain

**Step 1: Update stable documentation**

Document that Claude compaction reuses provider-only cached main-prefix bytes, that cache metadata never enters the ledger, and that cache miss cannot affect replay or correctness. State that OpenAI continues using the legacy dedicated summarizer.

**Step 2: Run focused verification**

```bash
pnpm test -- src/agent/compaction.test.ts src/agent/compaction-serialization.test.ts src/agent/compaction-token-estimator.test.ts src/agent/claude-code/request.test.ts src/agent/claude-code/llm-client.test.ts src/agent/openai-agent/llm-client.test.ts src/agent/react-kernel.test.ts src/agent/bot-loop-agent.test.ts src/agent/working-context.test.ts
pnpm typecheck
git diff --check
```

Expected: PASS.

**Step 3: Run repository verification**

```bash
pnpm repo-check
pnpm test
```

Expected: PASS. If `repo-check` still reports the pre-existing `workspace_bash db/style/metrics` prompt-rule drift, report it separately and do not broaden this task without authorization.

**Step 4: Inspect final scope**

```bash
git status --short
git diff --stat HEAD~1
```

Confirm the unrelated untracked `docs/plans/2026-07-13-architecture-doc-sync.md` remains untouched.

**Step 5: Commit documentation or final cleanup**

```bash
git add docs/AGENT_CONTEXT.md docs/TOOLS.md docs/TECH_DEBT.md
git commit -m "docs: 记录 Claude 缓存复用压缩"
```
