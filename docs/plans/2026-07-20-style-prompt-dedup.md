# 聊天风格 Prompt 去重 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 清理 `bot-style.md` 内部重复并固定 section 所有权，同时保持 system、constraints、工具路由和 replay 边界不变。

**Architecture:** `chat_style` 和 `workspace_bash style` 继续通过现有 `loadPromptSection` 读取同一组 section；只改变 `bot-style.md` 的静态内容。用 focused tests 断言 index、base、anti-patterns 和 special-cases 各自拥有正确内容。

**Tech Stack:** Markdown prompt sections、TypeScript、Node.js test runner、pnpm

---

### Task 1: 锁定 section 所有权

**Files:**
- Modify: `src/agent/tools/chat-style.test.ts`

**Step 1: Write the failing test**

增加测试，要求：

- index 明确只有 `style_index` section 是索引；
- base 不再包含完整角色扮演流程、固定“半参与”档位或空闲自主调度；
- special cases 保留角色扮演，但不再包含通用运维术语规则；
- anti-patterns 继续拥有运维术语反例；
- base 的 ambient 参与说明受 participation 允许条件约束。

**Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/tools/chat-style.test.ts`

Expected: FAIL，因为现有 base/special sections 仍有重复，index 也误称整份文件只是索引。

### Task 2: 最小清理 bot-style.md

**Files:**
- Modify: `prompts/bot-style.md`

**Step 1: Write minimal implementation**

按设计删除重复段落，修正 index 措辞，并把群聊自然参与条件绑定到 participation 允许 ambient 的群。不要改 section marker、`bot-system.md`、`bot-chat-constraints.md` 或工具代码。

**Step 2: Run focused tests**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/tools/chat-style.test.ts src/agent/tools/workspace-bash.test.ts`

Expected: 全部通过。

### Task 3: 验证渐进披露边界

**Files:**
- Verify: `prompts/bot-style.md`
- Verify: `prompts/bot-system.md`
- Verify: `prompts/bot-chat-constraints.md`

**Step 1: Run repository checks**

Run: `pnpm repo-check && git diff --check`

Expected: 全部退出码为 0。

**Step 2: Review scope**

Run: `git diff -- prompts/bot-style.md src/agent/tools/chat-style.test.ts docs/plans/2026-07-20-style-prompt-dedup.md`

Expected: 无 system、constraints、runtime、schema 或 ledger 变更。
