# Targeted Memory Recall Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 person/group Memory recall 必须携带目标 ID，并优化 Agent 的召回工具引导。

**Architecture:** 在现有 Markdown recall 路径增加可选 `id` 输入；当 scope 是 person/group 时用它选择唯一文件，其他召回路径保持不变。工具 schema 同步执行交叉字段校验，runtime 和 system prompt 不变。

**Tech Stack:** TypeScript、Zod、Node test runner、Markdown Memory store

---

### Task 1: 定向召回和工具引导

**Files:**
- Modify: `src/agent/memory-store.ts`
- Modify: `src/agent/memory-store.test.ts`
- Modify: `src/agent/tools/memory.ts`
- Modify: `src/agent/tools/memory.test.ts`
- Modify: `docs/MEMORY_ARCHITECTURE.md`
- Modify: `docs/TOOLS.md`

**Step 1: 写失败测试**

- 在 store 测试中写入两个包含相同关键词的人物记忆，断言 `scope=person,id=目标QQ` 只返回目标文件。
- 断言 `scope=person|group` 缺少 `id`、以及 `self|topic` 携带 `id` 时被拒绝。
- 在 tool 测试中断言 schema 接受合法定向 recall、拒绝无目标 recall，并检查 description 包含“不重复召回”和 `search`/`recall` 分工。

**Step 2: 运行测试确认 RED**

Run:

```bash
pnpm test src/agent/memory-store.test.ts src/agent/tools/memory.test.ts
```

Expected: FAIL，因为 recall 尚无 `id` 参数和定向过滤。

**Step 3: 最小实现**

- 给 `RecallMemoryInput` 和 recall Zod 分支增加 `id`。
- person/group 要求 `id`，self/topic 禁止 `id`。
- person/group 带 id 时只扫描对应 Markdown 文件；文件不存在时返回空结果。
- 把 `id` 从 tool executor 传给 store。
- 调整 tool description：上下文不足时用 recall，上下文已有时不重复；search 只做宽泛发现。
- 同步两份现有架构文档。

**Step 4: 验证 GREEN**

Run:

```bash
pnpm test src/agent/memory-store.test.ts src/agent/tools/memory.test.ts src/agent/memory-recall-eval.test.ts src/agent/tool-schema.test.ts
pnpm typecheck
pnpm repo-check
```

Expected: 全部通过。

**Step 5: 提交**

```bash
git add src/agent/memory-store.ts src/agent/memory-store.test.ts src/agent/tools/memory.ts src/agent/tools/memory.test.ts docs/MEMORY_ARCHITECTURE.md docs/TOOLS.md
git commit -m "feat: 支持定向记忆召回"
```
