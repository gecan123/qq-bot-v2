# Rest Resume Reminder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在自然休息结束后有界 append 一次 Claude Code 风格 reminder，促使 Luna 立即执行刚留下的 resume plan，同时保持 replay、tool 原子性与单提交可回滚。

**Architecture:** `rest` 工具通过 runtime-only pause effect 披露休息是自然结束还是被打断；`BotLoopAgent` 只对自然结束调用一个纯函数，根据 durable ledger 判断当前空闲周期是否已经提醒以及 10 分钟上限。Reminder 使用固定模板，不复制模型或外部内容，append 后立即进入 snapshot。

**Tech Stack:** TypeScript、Node.js test runner、Zod、现有 `AgentContext` / `BotLoopAgent` / tool effect 契约。

---

### Task 1: Reminder 纯策略

**Files:**
- Create: `src/agent/rest-resume-reminder.ts`
- Test: `src/agent/rest-resume-reminder.test.ts`
- Modify: `src/agent/compaction.ts`
- Test: `src/agent/compaction.test.ts`

**Step 1: Write the failing tests**

覆盖固定模板、首次允许、无实际动作连续休息去重、有动作但不足 10 分钟抑制、有动作且达到 10 分钟允许。

**Step 2: Run test to verify it fails**

Run: `node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/rest-resume-reminder.test.ts`

Expected: FAIL，因为模块尚不存在。

**Step 3: Write minimal implementation**

实现：

```ts
export const REST_RESUME_REMINDER_MIN_INTERVAL_MS = 10 * 60 * 1000

export function renderRestResumeReminder(now: Date): string

export function shouldAppendRestResumeReminder(
  messages: readonly AgentMessage[],
  now: Date,
): boolean
```

策略从最后一条合法 marker（或 compaction 携带的固定 `rest_resume_state`）开始扫描；只有后续存在非 `pause` / `rest` assistant tool call 才算进入新的活动周期，并继续检查 10 分钟间隔。Compaction 状态不包含 reminder instruction，下一次摘要前由 Runtime 剥离。

**Step 4: Run test to verify it passes**

Run: `node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/rest-resume-reminder.test.ts`

Expected: PASS。

### Task 2: Pause effect 披露自然结束状态

**Files:**
- Modify: `src/agent/tool.ts`
- Modify: `src/agent/tools/rest.ts`
- Modify: `src/agent/effect-interpreter.ts`
- Test: `src/agent/tools/rest.test.ts`
- Test: `src/agent/effect-interpreter.test.ts`

**Step 1: Write the failing tests**

断言自然结束 effect 带 `status: 'elapsed'`，被打断 effect 带 `status: 'interrupted'`；EffectInterpreter 继续返回 `didPause=true`，并只对 elapsed 返回 `didCompleteRest=true`。旧式 `{type:'pause'}` 保持兼容但不触发 reminder。

**Step 2: Run tests to verify they fail**

Run: `node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/tools/rest.test.ts src/agent/effect-interpreter.test.ts`

Expected: FAIL，因为 effect 还没有 status，解释器也没有 `didCompleteRest`。

**Step 3: Write minimal implementation**

把 pause effect 扩展为：

```ts
export type ToolEffect = {
  type: 'pause'
  status?: 'elapsed' | 'interrupted'
}
```

`restResult()` 写入 status；解释器只信任 `pause` / `rest` 工具名，并把 elapsed 聚合为 `didCompleteRest`。

**Step 4: Run tests to verify they pass**

Run: `node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/tools/rest.test.ts src/agent/effect-interpreter.test.ts`

Expected: PASS。

### Task 3: BotLoop append 与持久化

**Files:**
- Modify: `src/agent/bot-loop-agent.ts`
- Test: `src/agent/bot-loop-agent.test.ts`
- Test: `src/agent/goal-runtime.test.ts`

**Step 1: Write the failing tests**

覆盖：

- elapsed pause effect 在 tool result 完整 append 后增加 reminder；
- interrupted 或 legacy pause effect 不增加；
- reminder 位于本轮 compaction / Goal continuation 之后；
- reminder append 后发生额外 snapshot save。

**Step 2: Run test to verify it fails**

Run: `node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/bot-loop-agent.test.ts`

Expected: FAIL，因为 BotLoop 尚未 append reminder。

**Step 3: Write minimal implementation**

让 `runRound()` 返回 `didCompleteRest`。`step()` 保持原有 round snapshot 并执行 Life Journal，再在 compaction 前从完整 ledger 调用纯策略判定资格；随后执行 compaction 和 Goal continuation，最后 append reminder，并在 reminder 或 compaction 改变 ledger 时立即保存。

**Step 4: Run test to verify it passes**

Run: `node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/bot-loop-agent.test.ts`

Expected: PASS。

### Task 4: 契约文档与集中验证

**Files:**
- Modify: `docs/AGENT_CONTEXT.md`

**Step 1: Document the invariant**

记录 reminder 只在 elapsed rest 后 append、固定模板不承载外部内容、频率由 ledger 决定、不能切开 tool call/result。

**Step 2: Run focused tests**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/rest-resume-reminder.test.ts \
  src/agent/tools/rest.test.ts \
  src/agent/tools/pause.test.ts \
  src/agent/effect-interpreter.test.ts \
  src/agent/react-kernel.test.ts \
  src/agent/bot-loop-agent.test.ts \
  src/agent/goal-runtime.test.ts \
  src/agent/compaction.test.ts \
  src/agent/snapshot-integrity.test.ts
```

Expected: PASS。

**Step 3: Run repository verification**

Run: `pnpm repo-check`

Expected: PASS。

**Step 4: Review and create the single rollback commit**

确认 `git diff --check`、`git status --short` 和 diff 只包含本功能，然后创建唯一提交：

```bash
git add docs/plans/2026-07-13-rest-resume-reminder-design.md \
  docs/plans/2026-07-13-rest-resume-reminder.md \
  docs/AGENT_CONTEXT.md \
  src/agent/rest-resume-reminder.ts \
  src/agent/rest-resume-reminder.test.ts \
  src/agent/compaction.ts \
  src/agent/compaction.test.ts \
  src/agent/tool.ts \
  src/agent/tools/rest.ts \
  src/agent/tools/rest.test.ts \
  src/agent/effect-interpreter.ts \
  src/agent/effect-interpreter.test.ts \
  src/agent/bot-loop-agent.ts \
  src/agent/bot-loop-agent.test.ts \
  src/agent/goal-runtime.test.ts
git commit -m "feat: 增加醒后自主行动提醒"
```
