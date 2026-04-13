# Proactive Implicit Text Policy Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce `@` mention replies to keep implicit-text fallback while proactive replies remain silent unless the model calls `final_answer`.

**Architecture:** Add an explicit `allowImplicitText` policy at the agent loop boundary and propagate it via `runAgentSession`. Keep default behavior backward-compatible (`true`), then configure mention and proactive callers with explicit opposite policies.

**Tech Stack:** TypeScript (ESM), Node test runner via `tsx --test`, existing agent/responder modules.

---

## File Structure

- Modify: `src/agent/loop.ts`
  - Responsibility: enforce `allowImplicitText` policy when model returns direct text.
- Modify: `src/responder/agent-session.ts`
  - Responsibility: session-level policy passthrough to loop.
- Modify: `src/responder/reply-generator.ts`
  - Responsibility: mention flow explicitly allows implicit text fallback.
- Modify: `src/responder/proactive/generator.ts`
  - Responsibility: proactive flow explicitly disallows implicit text fallback.
- Modify: `src/agent/loop.test.ts`
  - Responsibility: lock core policy behavior.
- (Optional, if needed) Modify: `src/responder/agent-session.test.ts`
  - Responsibility: lock session parameter propagation if mocking strategy is available.
- Modify: `docs/superpowers/specs/2026-04-13-proactive-implicit-text-policy-design.md`
  - Responsibility: mark implementation status (post-implementation check).

---

### Task 1: Lock loop-level policy behavior with tests

**Files:**
- Modify: `src/agent/loop.test.ts`
- Test: `src/agent/loop.test.ts`

- [ ] **Step 1: Add failing test for disallowed implicit text**

```ts
test('returns fallback when implicit text is disallowed', async () => {
  const chatFn = makeChatFn([{ type: 'text', content: '这个我刚说过了，不重复。' }])
  const result = await runAgentLoop({
    systemPrompt: 'test',
    userMessage: '问题',
    chatFn,
    tools: [],
    executors: {},
    allowImplicitText: false,
  })
  assert.equal(result.state, 'fallback')
  if (result.state === 'fallback') assert.equal(result.reason, 'implicit_text_disallowed')
})
```

- [ ] **Step 2: Add explicit allow test (compat mode)**

```ts
test('keeps implicit text final when allowImplicitText is true', async () => {
  const chatFn = makeChatFn([{ type: 'text', content: '直接回复' }])
  const result = await runAgentLoop({
    systemPrompt: 'test',
    userMessage: '问题',
    chatFn,
    tools: [],
    executors: {},
    allowImplicitText: true,
  })
  assert.equal(result.state, 'final')
})
```

- [ ] **Step 3: Run targeted tests and verify failure first**

Run: `pnpm test -- src/agent/loop.test.ts`
Expected: FAIL on new test(s) before implementation.

- [ ] **Step 4: Commit test-only checkpoint**

```bash
git add src/agent/loop.test.ts
git commit -m "test: 增加implicit_text策略回归用例"
```

---

### Task 2: Implement loop policy switch

**Files:**
- Modify: `src/agent/loop.ts`
- Test: `src/agent/loop.test.ts`

- [ ] **Step 1: Add optional `allowImplicitText?: boolean` to `AgentLoopParams`**

Implementation note:
- Default to `true` in `executeLoop` parameter destructuring to preserve compatibility.

- [ ] **Step 2: Branch `turnResult.type === 'text'` by policy**

Implementation outline:

```ts
if (turnResult.type === 'text') {
  if (!allowImplicitText) {
    log.warn({ step, content: turnResult.content.slice(0, 50) }, 'agent_loop_implicit_text_disallowed')
    return finish({ state: 'fallback', reason: 'implicit_text_disallowed' }, 'implicit_text')
  }
  // existing implicit_text final behavior
}
```

- [ ] **Step 3: Run targeted tests**

Run: `pnpm test -- src/agent/loop.test.ts`
Expected: PASS for both allow/disallow cases and existing loop tests.

- [ ] **Step 4: Commit implementation checkpoint**

```bash
git add src/agent/loop.ts src/agent/loop.test.ts
git commit -m "feat: 支持按场景禁用implicit_text兜底"
```

---

### Task 3: Propagate policy via session and callers

**Files:**
- Modify: `src/responder/agent-session.ts`
- Modify: `src/responder/reply-generator.ts`
- Modify: `src/responder/proactive/generator.ts`
- Test: `src/responder/reply-generator.test.ts` (if needed)

- [ ] **Step 1: Extend `AgentSessionParams` with `allowImplicitText?: boolean`**

Implementation:
- Pass through to `runAgentLoop({... allowImplicitText: params.allowImplicitText })`.

- [ ] **Step 2: Set mention flow explicit allow**

In `src/responder/reply-generator.ts` `runAgentSession(...)` call:

```ts
allowImplicitText: true,
```

- [ ] **Step 3: Set proactive flow explicit disallow**

In `src/responder/proactive/generator.ts` `runAgentSession(...)` call:

```ts
allowImplicitText: false,
```

- [ ] **Step 4: Run responder-targeted tests**

Run:
- `pnpm test -- src/responder/reply-generator.test.ts`
- `pnpm test -- src/responder/agent-session.test.ts`

Expected: PASS; if no proactive unit coverage exists, this is acceptable at this stage.

- [ ] **Step 5: Commit caller policy wiring**

```bash
git add src/responder/agent-session.ts src/responder/reply-generator.ts src/responder/proactive/generator.ts
git commit -m "feat: 区分@回复与主动回复的implicit_text策略"
```

---

### Task 4: Full verification and log-level acceptance check

**Files:**
- Modify: `docs/superpowers/specs/2026-04-13-proactive-implicit-text-policy-design.md` (status update only)

- [ ] **Step 1: Run focused full test sweep**

Run:
- `pnpm test -- src/agent/loop.test.ts src/responder/reply-generator.test.ts src/responder/agent-session.test.ts`
- `pnpm build`

Expected:
- Tests PASS
- Build PASS

- [ ] **Step 2: Dry-run behavior acceptance**

Manual verification procedure:
1. Run app in dry-run mode.
2. Trigger repeated-topic proactive scenario.
3. Confirm logs show `agent_loop_implicit_text_disallowed` and no `[DRY RUN]` text generated from implicit-text fallback.
4. Trigger `@` mention scenario with text-only model response (or mocked adapter path) and confirm reply still produced.

- [ ] **Step 3: Update spec status and finalize docs commit**

```bash
git add docs/superpowers/specs/2026-04-13-proactive-implicit-text-policy-design.md
git commit -m "docs: 更新implicit_text策略隔离设计的实施状态"
```

---

## Rollout Notes

- Keep `allowImplicitText` default `true` for compatibility.
- If proactive silence rate is unexpectedly high, rollback by setting proactive caller to `allowImplicitText: true`.
- Do not add phrase blacklist unless data proves policy switch alone is insufficient.

## Execution Order

1. Task 1
2. Task 2
3. Task 3
4. Task 4
