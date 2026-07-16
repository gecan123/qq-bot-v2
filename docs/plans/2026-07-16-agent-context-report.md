# Agent Context 快照分析简化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every code task and superpowers:verification-before-completion before delivery.

**Goal:** 把现有 `agent:context` 从 provider 精确分摊实现收敛为小型启动快照和单遍近似估算，同时保留 canonical、working projection、只读和零 LLM 污染边界。

**Architecture:** bot 启动时原子写入只含三个固定 token 合计的小型 surface v2。CLI raw read canonical state，构建 deterministic projection 和 working projection，单遍遍历 `AgentMessage` 分类，再渲染 schema v2 文本或 JSON。旧 surface/report schema 直接替换，不增加兼容 bridge。

**Tech Stack:** TypeScript ESM、Node test runner、Prisma、Zod、pnpm。

---

仓库按 `AGENTS.md` 直接在 `main` 开发；不要创建 worktree，不要触碰 `data/agent-workspace/` 或用户未跟踪的 `docs/plans/2026-07-13-architecture-doc-sync.md`。

### Task 1: 精简 surface v2

**Files:**
- Modify: `src/ops/agent-context-surface.test.ts`
- Modify: `src/ops/agent-context-surface.ts`
- Modify: `src/index.ts`

**Step 1: 写失败测试**

把 surface fixture 改为 schema v2：

```ts
assert.deepEqual(surface, {
  schemaVersion: 2,
  generatedAt,
  provider: 'claude-code',
  model: 'claude-opus-4-7',
  contextWindowTokens: 1_000_000,
  fixedTokens: {
    systemIdentity: expectedIdentity,
    botSystemPrompt: expectedPrompt,
    visibleTools: expectedTools,
  },
})
```

覆盖：

- 不存在 `bytes`、`items`、`fingerprint`、`pid`。
- 旧 schema v1 读取为 invalid。
- missing / invalid / atomic overwrite。
- provider-specific tool converter 只影响 `visibleTools` 合计。
- `writeRuntimeAgentContextSurface` 只补 generatedAt。

删除 PID / EPERM / ESRCH / live / last_startup 测试。

**Step 2: 运行 RED**

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/agent-context-surface.test.ts
```

Expected: FAIL，因为实现仍输出 schema v1 和旧字段。

**Step 3: 最小实现**

- `AGENT_CONTEXT_SURFACE_SCHEMA_VERSION = 2`。
- `AgentContextSurface` 只保留设计文档中的字段。
- 删除 hash、stable stringify、BigInt totals、metric bytes、tool items、pid status helper。
- 保留 Zod strict reader 和随机临时文件 + rename。
- `buildAgentContextSurface` 直接计算三个 token 合计。
- `writeRuntimeAgentContextSurface` 只注入北京时间 generatedAt。
- `src/index.ts` 成功日志只记录 path、schemaVersion 和 generatedAt。

**Step 4: GREEN 和回归**

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx +  src/ops/agent-context-surface.test.ts src/index.test.ts src/agent/runtime.test.ts
pnpm typecheck
```

**Step 5: 提交**

```bash
git add src/ops/agent-context-surface.ts src/ops/agent-context-surface.test.ts src/index.ts
git commit -m "refactor: 简化上下文固定面快照"
```

### Task 2: 单遍消息估算与 report v2

**Files:**
- Modify: `src/ops/agent-context-report.test.ts`
- Modify: `src/ops/agent-context-report.ts`
- Modify: `src/ops/agent-context-report-render.test.ts`
- Modify: `src/ops/agent-context-report-render.ts`

**Step 1: 写失败测试**

将报告断言改为：

```ts
assert.equal(report.schemaVersion, 2)
assert.equal(report.estimatedSnapshotTokens, sumAvailableCategories(report.categories))
assert.equal(report.categories.systemIdentity, surface.fixedTokens.systemIdentity)
assert.equal(report.categories.userAndRuntimeMessages, expectedUserTokens)
```

覆盖：

- categories 的值直接是 `number | null`，没有 `available/tokens/percent` wrapper。
- 没有 `estimateComplete`、`estimatedKnownInputTokens`、`estimatedCurrentInputTokens`、`overTrigger`。
- user、assistant text、tool calls、thinking、tool text、image 分别归类。
- Claude thinking 只在 claude-code + adaptive + retention 允许时计数。
- OpenAI 和未知 provider 不计 native thinking。
- tool contributor 与 unmatched sentinel。
- surface missing 时固定分类为 null、estimatedSnapshotTokens 为 null，消息分类仍为 number。
- renderer 显示 Snapshot estimate、分类、free、headroom、contributors 和 snapshot status。

删除完整 Claude/OpenAI provider message envelope、fragment 守恒和最大余数分配测试。

**Step 2: 运行 RED**

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx +  src/ops/agent-context-report.test.ts src/ops/agent-context-report-render.test.ts
```

Expected: FAIL，因为 report 仍为 schema v1。

**Step 3: 最小实现**

- 删除 `buildClaudeCodeRequestBody` / `buildOpenAIAgentRequest` import。
- 删除 `ProviderMessageFragment`、两个 provider classifier 和最大余数分配。
- 单遍遍历 working messages，用 `estimateUtf8Tokens(JSON.stringify(value))` 估算各语义片段。
- 只保留 `shouldReplayClaudeNativeBlocks` 处理 Claude thinking retention。
- 固定分类读取 `surface.fixedTokens`。
- report 改成设计文档中的 schema v2。
- renderer 直接读取 category number/null；动态字符串继续转义控制字符。

**Step 4: GREEN 和回归**

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx +  src/ops/agent-context-report.test.ts +  src/ops/agent-context-report-render.test.ts +  src/agent/claude-code/request.test.ts +  src/agent/working-context.test.ts
pnpm typecheck
```

**Step 5: 提交**

```bash
git add src/ops/agent-context-report.ts src/ops/agent-context-report.test.ts +  src/ops/agent-context-report-render.ts src/ops/agent-context-report-render.test.ts
git commit -m "refactor: 简化上下文消息估算"
```

### Task 3: 复用 canonical raw loader并简单重读

**Files:**
- Modify: `src/ops/agent-ledger-check.test.ts`
- Modify: `src/ops/agent-ledger-check.ts`
- Modify: `src/ops/agent-context-report-source.test.ts`
- Modify: `src/ops/agent-context-report-source.ts`

**Step 1: 写失败测试**

为共享 loader 增加直接测试：

```ts
const canonical = await loadCanonicalAgentState(client)
assert.deepEqual(canonical, expected)
```

报告 source 测试要求：

- `createPrismaAgentContextReportSource` 复用共享 loader。
- projection 第一次失败时完整调用 `loadCanonicalState` 第二次。
- 第二次成功返回报告。
- 两次都损坏时抛出 integrity error。
- checkpoint 和 mutation 方法永不访问。

**Step 2: 运行 RED**

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx +  src/ops/agent-ledger-check.test.ts src/ops/agent-context-report-source.test.ts
```

Expected: FAIL，因为共享 loader 和重读不存在。

**Step 3: 最小实现**

- 从 `createPrismaAgentLedgerCheckSource` 提取并导出 `loadCanonicalAgentState(client)`。
- 两个 ops source 共用最小 ledger/runtime client interface。
- report source 只额外定义 latest usage 查询。
- `buildCurrentAgentContextReport` 用最多两次 `loadCanonicalState -> projectAgentLedger`；不加事务、锁、延迟或重试配置。

**Step 4: GREEN**

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx +  src/ops/agent-ledger-check.test.ts +  src/ops/agent-context-report-source.test.ts +  src/agent/agent-ledger-projection.test.ts
pnpm typecheck
```

**Step 5: 提交**

```bash
git add src/ops/agent-ledger-check.ts src/ops/agent-ledger-check.test.ts +  src/ops/agent-context-report-source.ts src/ops/agent-context-report-source.test.ts
git commit -m "refactor: 复用上下文账本只读加载"
```

### Task 4: 简化 CLI 和脚本类型边界

**Files:**
- Modify: `src/ops/agent-context-cli.test.ts`
- Modify: `src/ops/agent-context-cli.ts`
- Modify: `scripts/agent-context.ts`
- Modify: `package.json`
- Delete: `tsconfig.scripts.json`

**Step 1: 写失败测试**

将 CLI API 收敛为：

```ts
export async function buildAgentContextCliOutput(
  args: string[],
  loadRuntime?: () => Promise<AgentContextCliRuntime>,
): Promise<string>
```

测试：

- fake runtime 成功时连接、构建、断开，返回纯 JSON 或文本字符串。
- build 失败仍断开。
- disconnect 失败使 Promise reject，不返回已经构建的输出。
- 缺配置的真实脚本 stderr 是单行结构化 JSON、stdout 为空。
- `pnpm --silent ... --json` 错误路径无 pnpm banner。

删除自定义 IO、`AgentContextCliDependencies` 和 exit-code runner 测试。

**Step 2: RED**

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/agent-context-cli.test.ts
```

Expected: FAIL，因为新 API 不存在。

**Step 3: 最小实现**

- 保留一个可选 `loadRuntime` seam。
- 默认 loader 动态 import config、Prisma、image store。
- helper 内 connect，`try/finally` disconnect，然后返回 renderer 字符串。
- script 只 catch error、输出稳定 JSON error、设置 exitCode。
- 删除 `tsconfig.scripts.json`；production 逻辑都在 `src`，12 行脚本与仓库其他 scripts 保持一致。
- `package.json typecheck` 恢复 `tsc --noEmit`。

**Step 4: GREEN**

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx +  src/ops/agent-context-cli.test.ts +  src/ops/agent-context-report-source.test.ts +  src/ops/agent-context-report-render.test.ts
pnpm typecheck
```

**Step 5: 提交**

```bash
git add src/ops/agent-context-cli.ts src/ops/agent-context-cli.test.ts +  scripts/agent-context.ts package.json tsconfig.scripts.json
git commit -m "refactor: 简化上下文命令入口"
```

### Task 5: 文档与最终验证

**Files:**
- Modify: `docs/OPERATIONS.md`

**Step 1: 更新文档**

明确：

- surface 是 schema v2 固定 token 快照，没有 live/last-startup 判定。
- report schema v2 使用 `estimatedSnapshotTokens`。
- 分类是单遍本地近似，不保证等于 provider request JSON。
- 命令仍严格只读、零 LLM context 污染。

**Step 2: focused tests**

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx +  src/agent/compaction-token-estimator.test.ts +  src/agent/working-context.test.ts +  src/agent/claude-code/request.test.ts +  src/ops/agent-context-surface.test.ts +  src/ops/agent-context-report.test.ts +  src/ops/agent-context-report-source.test.ts +  src/ops/agent-context-report-render.test.ts +  src/ops/agent-context-cli.test.ts +  src/ops/agent-ledger-check.test.ts +  src/index.test.ts
```

**Step 3: 全仓验证**

```bash
pnpm test
pnpm typecheck
pnpm repo-check
git diff --check
git status --short
```

不为 smoke test 启动真实 bot 或外部服务。只有当前配置和 Postgres 已可用时才运行真实 CLI，否则明确跳过。

**Step 4: 检查复杂度**

```bash
wc -l scripts/agent-context.ts src/ops/agent-context-{cli,report,report-source,report-render,surface}.ts
git diff --stat 3516351..HEAD
```

确认删除 provider fragment/max-remainder、PID liveness、surface bytes/items/fingerprint、CLI IO scaffold 和专用 script tsconfig。

**Step 5: 提交**

```bash
git add docs/OPERATIONS.md
git commit -m "docs: 更新上下文快照分析说明"
```
