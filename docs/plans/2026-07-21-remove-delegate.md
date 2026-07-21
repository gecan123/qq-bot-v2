# Remove Generic Delegate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the unused generic `delegate` LLM worker, its scheduler lane, policy, tests, and documentation without changing the main Agent ledger or specialized background workers.

**Architecture:** The main `BotLoopAgent` remains the only general LLM loop. Existing typed background workers and `background_task` remain intact; only the generic clean-context delegate is removed. Historical ledger entries remain immutable and replayable because replay validates tool-call/result structure rather than requiring every historical tool to remain registered.

**Tech Stack:** TypeScript 5.9, Node.js test runner via `tsx`, pnpm, ESM-only imports, Zod, Prisma/PostgreSQL (unchanged by this work).

---

### Task 1: Lock the intended public tool and scheduler surface with failing tests

**Files:**
- Modify: `src/agent/runtime.test.ts:117`
- Modify: `src/agent/task-scheduler.test.ts:1-4`

**Step 1: Change the runtime tool-list expectation**

Remove `'delegate'` from the expected always-on tool names in `src/agent/runtime.test.ts`:

```ts
assert.deepEqual(runtime.tools.list().map((tool) => tool.name), [
  'pause',
  'qq_directory',
  'background_task',
  'approval',
  'goal',
  'todo',
  'skill',
  'memory',
  'inbox',
  'chat_style',
  'ai_tone',
  'workspace_bash',
  'help',
  'invoke',
])
```

**Step 2: Add a default-lane contract test**

Import `AGENT_TASK_LANES` and add:

```ts
test('default agent lanes contain only active specialized workers', () => {
  assert.deepEqual(Object.keys(AGENT_TASK_LANES), [
    'maintenance',
    'network',
    'media-description',
  ])
})
```

**Step 3: Run the focused tests and verify they fail**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/runtime.test.ts src/agent/task-scheduler.test.ts
```

Expected: FAIL because the runtime still registers `delegate` and `AGENT_TASK_LANES` still contains the `delegate` key.

### Task 2: Remove the generic delegate implementation and wiring

**Files:**
- Delete: `src/agent/tools/delegate.ts`
- Delete: `src/agent/tools/delegate.test.ts`
- Modify: `src/agent/tools/index.ts:37,144-154`
- Modify: `src/agent/tools/policies.ts:43-50`
- Modify: `src/agent/task-scheduler.ts:18-23`

**Step 1: Remove tool construction and registration**

Delete the `createDelegateTool` import, the local `delegate` construction, and the conditional spread from `tools` in `src/agent/tools/index.ts`. Keep `taskScheduler`, `workspaceBash`, `inbox`, `qqDirectory`, `chatStyle`, `aiTone`, `skillTool`, and `backgroundTask`; they all have other consumers.

The resulting beginning of the always-on list must be:

```ts
const tools: Tool[] = [
  pause,
  qqDirectory,
  backgroundTask,
  ...(deps.approvalManager ? [createApprovalTool(deps.approvalManager)] : []),
  ...(deps.goalStore ? [createGoalTool(deps.goalStore)] : []),
  todoTool,
  skillTool,
  // existing tools continue unchanged
]
```

**Step 2: Remove the centralized policy entry**

Delete only:

```ts
delegate: fixed(EXCLUSIVE_READ),
```

Do not remove `EXCLUSIVE_READ`; other tool policies use it.

**Step 3: Remove the scheduler lane**

Change the constant to:

```ts
export const AGENT_TASK_LANES = {
  maintenance: { concurrency: 1 },
  network: { concurrency: 3 },
  'media-description': { concurrency: 2 },
} as const
```

Do not alter generic custom-lane support in `createTaskScheduler()`.

**Step 4: Delete the delegate source and test files**

Delete `src/agent/tools/delegate.ts` and `src/agent/tools/delegate.test.ts`. Do not change `runReactRound()` or its `stagedMessages` support.

**Step 5: Run the focused tests and verify they pass**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/runtime.test.ts \
  src/agent/task-scheduler.test.ts \
  src/agent/tools/merged-tools.test.ts
```

Expected: PASS.

**Step 6: Commit the code removal**

```bash
git add src/agent/runtime.test.ts src/agent/task-scheduler.test.ts \
  src/agent/tools/index.ts src/agent/tools/policies.ts src/agent/task-scheduler.ts \
  src/agent/tools/delegate.ts src/agent/tools/delegate.test.ts
git commit -m "refactor: 移除通用 delegate 能力"
```

### Task 3: Remove runtime guidance and stale local-context commentary

**Files:**
- Modify: `src/agent/goal-render.ts:20-25`
- Modify: `src/agent/agent-context.ts:22-30`

**Step 1: Update Goal scheduling guidance**

Replace the background guidance with:

```ts
background: '可使用现有 background_task 并发独立工作；不要创建第二个主循环。',
```

This preserves the existing single-loop contract without advertising a removed tool.

**Step 2: Generalize the AgentContext comment**

Replace the delegate-specific comment with:

```ts
*  - appendXxx 只服务不持久化的局部 AgentContext 和测试 fixture
```

Keep every `AgentContext` method unchanged.

**Step 3: Run relevant tests**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/goal-runtime.test.ts \
  src/agent/agent-context.test.ts \
  src/agent/bot-system-prompt.test.ts
```

Expected: PASS.

**Step 4: Commit the runtime wording cleanup**

```bash
git add src/agent/goal-render.ts src/agent/agent-context.ts
git commit -m "refactor: 清理 delegate 运行时引导"
```

### Task 4: Synchronize architecture, tools, harness, and technical-debt docs

**Files:**
- Modify: `docs/TOOLS.md:20`
- Modify: `docs/ARCHITECTURE.md:17,82`
- Modify: `docs/AGENT_CONTEXT.md:59`
- Modify: `docs/HARNESS_COMPARISON.md:12,26,33`
- Modify: `docs/TECH_DEBT.md:21-23,25-32,76-80,115-123`

**Step 1: Remove delegate capability claims**

- Delete the `delegate` bullet from `docs/TOOLS.md`.
- Remove `delegate=2` from the scheduler lane list in `docs/ARCHITECTURE.md`.
- Describe parallel work as typed bounded background tasks, not `background task/delegate`.
- Mark generic subagent support as intentionally absent in `docs/HARNESS_COMPARISON.md`; keep `trading_agent` documented as a specialized worker.
- Remove `restricted delegate` from the comprehensive harness summary and delete the dedicated delegate gap item.

**Step 2: Update the technical-debt inventory**

- Remove the delegate P0 section. If the P0 section would otherwise be empty, state that there are currently no known P0 correctness defects.
- Remove delegate-specific usage attribution and cache-key wording. Keep the broader gap that auxiliary LLM calls lack unified `actor/operation/taskId/goalId` accounting and stable prompt-family separation.
- Remove “fix delegate” from the recommended repayment order and renumber the remaining items.

Do not resolve the separate Memory retention decision in this commit; it belongs to the later P1 design.

**Step 3: Correct the WebAdmin baseline wording**

Replace the claim that WebAdmin is wholly read-only with the current contract: observation features are read-only, while the fixed operations feature is the only controlled mutation boundary.

**Step 4: Check for stale product references**

Run:

```bash
rg -n "受限委派|background_task/delegate|delegate=2|restricted delegate|修复 delegate|通用 delegate" \
  src docs README.md prompts
```

Expected: only the approved design/implementation plan may mention the removed feature historically. Generic English “delegate” references in Prisma-generated ORM code or unrelated adapter terminology are not product references.

**Step 5: Run repository documentation checks**

Run:

```bash
pnpm repo-check
git diff --check
```

Expected: both pass.

**Step 6: Commit documentation synchronization**

```bash
git add docs/TOOLS.md docs/ARCHITECTURE.md docs/AGENT_CONTEXT.md \
  docs/HARNESS_COMPARISON.md docs/TECH_DEBT.md
git commit -m "docs: 同步移除 delegate 后的架构"
```

### Task 5: Run full verification and inspect scope

**Files:**
- Verify only; no planned source changes.

**Step 1: Run type checking**

```bash
pnpm typecheck
```

Expected: PASS with no missing delegate imports or lane references.

**Step 2: Run the root test suite**

```bash
pnpm test
```

Expected: PASS.

**Step 3: Run repository checks again**

```bash
pnpm repo-check
git diff --check
```

Expected: PASS.

**Step 4: Inspect final references and worktree**

```bash
rg -n "createDelegateTool|DELEGATE_ALLOWED_TOOL_NAMES|delegate_return|lane: 'delegate'" src docs
git status --short
git log -4 --oneline
```

Expected:

- No live implementation references remain.
- The approved design/plan may retain historical explanation.
- `docs/plans/2026-07-13-architecture-doc-sync.md` remains untouched and untracked.
- No files under `data/agent-workspace/` are added.

**Step 5: If verification required fixes, commit only those fixes**

Use the repository commit format and stage exact files only:

```bash
git add <exact-fixed-files>
git commit -m "fix: 完善 delegate 删除后的验证"
```

Skip this commit when no fixes are needed.
