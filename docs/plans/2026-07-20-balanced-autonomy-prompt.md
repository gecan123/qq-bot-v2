# 均衡自主提示词 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Luna 在个人探索、创造和自然社交之间自主选择可验证的下一步，同时允许没有值得行动的方向时安静结束。

**Architecture:** 只修改启动时冻结的 `prompts/bot-system.md` 固定内核，不增加动态 prompt 注入，不改变 ledger、replay、Goal、mailbox 或工具契约。保留现有强制 `tool_choice`，其与无工具结束语义的冲突继续记录在技术债中。

**Tech Stack:** Markdown prompt sections、TypeScript、Node.js test runner、pnpm repo checks

---

### Task 1: 锁定均衡自主行为

**Files:**
- Modify: `src/agent/bot-system-prompt.test.ts`

**Step 1: Write the failing test**

在现有稳定人格测试中增加断言，要求渲染后的 prompt 明确包含：

- 从最近线索、稳定兴趣、wishes、关系和已有成果形成候选方向；
- 在研究、创作和自然联系熟人之间均衡选择；
- 一次推进一个可验证步骤，跨轮时建立 self Goal/currentCommitment；
- 自主不等于持续忙碌或频繁发言，没有值得行动的方向时允许无工具结束。

同时保留已有身份、I/O、memory 和 prompt token 预算断言。

**Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/bot-system-prompt.test.ts`

Expected: FAIL，因为现有 `[行动基线]` 没有完整的候选方向与均衡自主循环措辞。

### Task 2: 实现最小 prompt 修改

**Files:**
- Modify: `prompts/bot-system.md`

**Step 1: Write minimal implementation**

重写 `[行动基线]`，使用正向、可执行的“形成候选 → 选择一步 → 获取证据 → 继续/replan/结束”循环；保留注意事件、active Goal、安静结束、反机械忙碌和 token 预算边界。

补齐现有测试要求的 `memory` 稳定事实按需 `recall` 表述，不加入任何动态内容。

**Step 2: Run test to verify it passes**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/bot-system-prompt.test.ts`

Expected: 4 tests pass, 0 fail。

### Task 3: 验证固定 prompt 边界

**Files:**
- Verify: `prompts/bot-system.md`
- Verify: `src/agent/bot-system-prompt.test.ts`
- Verify: `docs/TECH_DEBT.md`

**Step 1: Run repository checks**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/bot-system-prompt.test.ts && pnpm repo-check && git diff --check`

Expected: 全部退出码为 0；prompt 仍低于 2,800 估算 tokens，技术债继续声明暂不切换 `tool_choice=auto`。

另行运行 `pnpm typecheck` 和 `src/agent/runtime.test.ts` 记录 broader baseline；不为本次 prompt 修改顺带修复 generated Prisma client 漂移或 visible-tools 预算超限。

**Step 2: Review scope**

Run: `git diff -- prompts/bot-system.md src/agent/bot-system-prompt.test.ts docs/TECH_DEBT.md docs/plans/2026-07-20-balanced-autonomy-prompt.md`

Expected: 不包含 provider、runtime、ledger、mailbox、Goal schema 或工具实现变更。
