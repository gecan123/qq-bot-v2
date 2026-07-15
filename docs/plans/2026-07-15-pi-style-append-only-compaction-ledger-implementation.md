# Pi-style Append-only Compaction Ledger Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用线性 append-only ledger 替换可覆盖 snapshot，使原始 LLM 历史永久保留、当前 prompt 可确定性重建，并实现 Pi 风格的动态预算、token tail、split-turn、previous-summary、manual/threshold/overflow compaction。

**Architecture:** PostgreSQL ledger 是 LLM 历史唯一事实源；可变 runtime state 只保存 cursor、Goal revision、capability 等控制状态；checkpoint 只是带 ledger head 和 fingerprint 的可删除缓存。Runtime Host 是唯一 writer，先事务提交 ledger/runtime state，再更新内存 projection，最后 best-effort 写 checkpoint。

**Tech Stack:** TypeScript 5.9、Node.js ESM、Prisma 7/PostgreSQL、`node:test`、现有 Claude Code/OpenAI agent provider adapters。

---

实施时始终遵守 [设计文档](./2026-07-15-pi-style-append-only-compaction-ledger-design.md) 的边界：不做 session tree，不兼容读取旧 snapshot，不从 side table 重建 prompt，不牺牲 tool-call/tool-result 原子性，也不把 `/compact` 暴露为 LLM tool。

## Task 1: 把模型窗口和 compact 预算变成显式配置

**Files:**

- Modify: `.env.example`
- Modify: `src/config/index.ts`
- Modify: `src/config/index.test.ts`
- Modify: `src/agent/llm-client.ts`
- Modify: `src/agent/llm-client.test.ts`
- Modify: `src/agent/claude-code/llm-client.ts`
- Modify: `src/agent/claude-code/llm-client.test.ts`
- Modify: `src/agent/openai-agent/llm-client.ts`
- Modify: `src/agent/openai-agent/llm-client.test.ts`
- Modify: `src/agent/persona-spoof-self-test.ts`
- Modify: `src/agent/persona-spoof-self-test.test.ts`
- Modify: `src/agent/react-kernel.test.ts`
- Modify: `src/agent/bot-loop-agent.test.ts`
- Modify: `src/agent/integration-multi-source.test.ts`
- Modify: `src/agent/runtime.test.ts`
- Modify: `src/agent/life-journal.test.ts`
- Modify: `src/agent/memory-maintenance.test.ts`
- Modify: `src/agent/tools/delegate.test.ts`
- Modify: `src/agent/tools/fetch-url.test.ts`
- Modify: `src/index.test.ts`

### Step 1: 写失败的 config 测试

在 `src/config/index.test.ts` 增加：

```ts
test('parses Pi-style compaction budgets', () => {
  const parsed = parseConfig(makeEnv({
    LLM_MODEL_CONTEXT_WINDOWS_JSON: '{"claude-sonnet":200000,"gpt-main":128000}',
    COMPACTION_RESERVE_TOKENS: '16384',
    COMPACTION_KEEP_RECENT_TOKENS: '20000',
  }))

  assert.deepEqual(parsed.compaction, {
    reserveTokens: 16384,
    keepRecentTokens: 20000,
    failureBackoffMs: 600000,
  })
  assert.equal(parsed.llm.contextWindowTokensByModel['claude-sonnet'], 200000)
})

test('rejects a reserve plus keep budget that cannot fit the model window', () => {
  assert.throws(
    () => parseConfig(makeEnv({
      LLM_MODEL_CONTEXT_WINDOWS_JSON: '{"claude-sonnet":30000}',
      COMPACTION_RESERVE_TOKENS: '16384',
      COMPACTION_KEEP_RECENT_TOKENS: '20000',
    })),
    /reserve plus keep.*smaller than.*context window/,
  )
})
```

同时删除旧 `COMPACTION_TRIGGER_TOKENS` 断言，增加 JSON 非法、窗口为零/非整数、default 或 fallback model 没有登记窗口的失败用例。

### Step 2: 运行测试确认失败

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/config/index.test.ts
```

Expected: FAIL，`parsed.compaction` 尚不存在。

### Step 3: 实现配置和稳定 LLM metadata

配置目标形态：

```ts
compaction: {
  reserveTokens: parsePositiveInteger(env.COMPACTION_RESERVE_TOKENS, 16_384),
  keepRecentTokens: parsePositiveInteger(env.COMPACTION_KEEP_RECENT_TOKENS, 20_000),
  failureBackoffMs: parsePositiveInteger(env.COMPACTION_FAILURE_BACKOFF_MS, 600_000),
}
```

在现有 `llm` config 下增加：

```ts
contextWindowTokensByModel: parseModelContextWindows(env.LLM_MODEL_CONTEXT_WINDOWS_JSON)
```

启动时要求 default model 和非空 fallback model 都有登记值，并逐模型验证 `reserveTokens + keepRecentTokens < contextWindowTokens`。这样 fallback 后的实际窗口不会错误沿用 primary model。

在 `LlmCallOutput` 增加：

```ts
contextWindowTokens: number
```

两个 provider adapter 都根据构造时的准确 model 从 registry 注入配置窗口，不能在代码里猜模型容量；fallback client 原样透传实际完成调用的 output。`.env.example` 删除旧 trigger，记录 `LLM_MODEL_CONTEXT_WINDOWS_JSON` 和三个 compact 变量及约束。

### Step 4: 补 provider 测试并运行

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/config/index.test.ts \
  src/agent/llm-client.test.ts \
  src/agent/claude-code/llm-client.test.ts \
  src/agent/openai-agent/llm-client.test.ts
pnpm typecheck
```

Expected: PASS；每条真实 completion 和测试 fixture 都携带配置窗口。

### Step 5: Commit

```bash
git add .env.example src/config/index.ts src/config/index.test.ts src/agent/llm-client.ts src/agent/llm-client.test.ts src/agent/claude-code/llm-client.ts src/agent/claude-code/llm-client.test.ts src/agent/openai-agent/llm-client.ts src/agent/openai-agent/llm-client.test.ts src/agent/persona-spoof-self-test.ts src/agent/persona-spoof-self-test.test.ts src/agent/react-kernel.test.ts src/agent/bot-loop-agent.test.ts src/agent/integration-multi-source.test.ts src/agent/runtime.test.ts src/agent/life-journal.test.ts src/agent/memory-maintenance.test.ts src/agent/tools/delegate.test.ts src/agent/tools/fetch-url.test.ts src/index.test.ts
git commit -m "feat: 增加动态压缩预算配置"
```

## Task 2: 定义版本化 ledger payload 和纯 projection

**Files:**

- Create: `src/agent/agent-ledger.types.ts`
- Create: `src/agent/agent-ledger-projection.ts`
- Create: `src/agent/agent-ledger-projection.test.ts`
- Modify: `src/agent/agent-context.types.ts`
- Modify: `src/agent/snapshot-integrity.ts`
- Modify: `src/agent/snapshot-integrity.test.ts`

### Step 1: 写 projection 失败测试

覆盖以下表格：

| Case | Expected projection |
|---|---|
| 只有 message entries | 全部按 ID 进入 context |
| 一次 compaction | 固定摘要 + 机器状态 + `firstKeptEntryId` 起的 message |
| 多次 compaction | 只解释最新 compaction，历史 compaction 不进入 prompt |
| 相同输入运行两次 | `JSON.stringify` 字节相同 |
| boundary 指向 tool result | 抛 `AgentLedgerIntegrityError` |
| tool call 缺 result | 抛 `AgentLedgerIntegrityError` |
| 未知 schemaVersion/type | fail closed |

测试 fixture 使用显式 bigint ID：

```ts
const entries: AgentLedgerEntry[] = [
  messageEntry(1n, { role: 'user', content: '旧问题' }),
  messageEntry(2n, assistantWithTool('call-1')),
  messageEntry(3n, toolResult('call-1', '旧结果')),
  compactionEntry(4n, {
    summary: validSummary('旧问题和结果'),
    firstKeptEntryId: '5',
  }),
  messageEntry(5n, { role: 'user', content: '新问题' }),
]
```

### Step 2: 运行测试确认失败

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/agent-ledger-projection.test.ts
```

Expected: FAIL，模块尚不存在。

### Step 3: 定义最小领域类型

`src/agent/agent-ledger.types.ts` 的公开契约：

```ts
export const AGENT_LEDGER_SCHEMA_VERSION = 1
export type CompactionReason = 'threshold' | 'overflow' | 'manual'

export interface MessageLedgerPayload {
  schemaVersion: 1
  message: DurableAgentMessage
}

export interface CompactionLedgerPayload {
  schemaVersion: 1
  summary: string
  firstKeptEntryId: string | null
  tokensBefore: number
  estimatedTokensAfter: number
  reason: CompactionReason
  isSplitTurn: boolean
  previousCompactionEntryId: string | null
  mailboxAttentionState: MailboxAttentionState
  restResumeState: RestResumeCompactionState | null
  manualFocus?: string
}

export type AgentLedgerEntry =
  | { id: bigint; entryType: 'message'; payload: MessageLedgerPayload; createdAt: Date }
  | { id: bigint; entryType: 'compaction'; payload: CompactionLedgerPayload; createdAt: Date }
```

`DurableAgentMessage` 初期与 `AgentMessage` 同构，但 image block 使用 Task 9 的稳定引用联合类型；解析函数必须逐字段校验，不能用类型断言信任 JSON。

### Step 4: 实现纯 projection

公开 API：

```ts
export function projectAgentLedger(input: {
  entries: readonly AgentLedgerEntry[]
  runtimeState: AgentRuntimeState
}): AgentLedgerProjection
```

projection 必须：

- 验证 ID 严格递增。
- 找到最新 compaction 并验证 `previousCompactionEntryId` 链。
- 从 `firstKeptEntryId` 开始选择 message，且包含 compaction 之后的新 message。
- 用固定函数渲染摘要和键排序机器状态。
- 最后复用 `validateBotSnapshotIntegrity` 验证 tool pair 和消息形态。
- 返回 `throughEntryId`、`activeEntryCount`、`permanentEntryCount` 和 snapshot。

### Step 5: 运行 focused tests

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/agent-ledger-projection.test.ts \
  src/agent/snapshot-integrity.test.ts
```

Expected: PASS。

### Step 6: Commit

```bash
git add src/agent/agent-ledger.types.ts src/agent/agent-ledger-projection.ts src/agent/agent-ledger-projection.test.ts src/agent/agent-context.types.ts src/agent/snapshot-integrity.ts src/agent/snapshot-integrity.test.ts
git commit -m "feat: 增加追加式账本投影"
```

## Task 3: 建立 canonical ledger、runtime state 和 cache schema

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260715193000_add_append_only_agent_ledger/migration.sql`
- Modify: `src/ops/repo-check.ts`
- Modify: `src/ops/repo-check.test.ts`
- Regenerate: `src/generated/prisma/**`

### Step 1: 先写 repo schema guard

把 `src/ops/repo-check.test.ts` 的 snapshot model 期望替换为：

```ts
model BotAgentLedgerEntry {
  @@map("bot_agent_ledger_entries")
}
model BotAgentRuntimeState {
  @@map("bot_agent_runtime_state")
}
model BotAgentCheckpoint {
  @@map("bot_agent_checkpoint")
}
```

并断言 schema 不再包含 `BotAgentSnapshot` 和 `BotAgentSnapshotCheckpoint`。

### Step 2: 运行测试确认失败

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/repo-check.test.ts
```

Expected: FAIL，仍是旧 snapshot schema。

### Step 3: 修改 Prisma schema

目标模型：

```prisma
model BotAgentLedgerEntry {
  id        BigInt   @id @default(autoincrement())
  entryType String   @map("entry_type")
  payload   Json
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([entryType, id])
  @@map("bot_agent_ledger_entries")
}

model BotAgentRuntimeState {
  id                     Int       @id
  schemaVersion          Int       @map("schema_version")
  mailboxCursors         Json      @map("mailbox_cursors")
  mailboxContinuity      Json      @map("mailbox_continuity")
  goalRevision           Int       @map("goal_revision")
  activeToolCapabilities Json      @map("active_tool_capabilities")
  lastWakeAt             DateTime? @map("last_wake_at") @db.Timestamptz(6)
  ledgerHeadEntryId      BigInt?   @map("ledger_head_entry_id")
  updatedAt              DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("bot_agent_runtime_state")
}

model BotAgentCheckpoint {
  id             Int      @id
  schemaVersion  Int      @map("schema_version")
  throughEntryId BigInt?  @map("through_entry_id")
  fingerprint    String
  projection     Json
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("bot_agent_checkpoint")
}
```

迁移 SQL：

- 删除 `bot_agent_snapshot_checkpoints`、`bot_agent_snapshot`。
- 创建三个新表及 `entry_type IN ('message','compaction')` CHECK。
- 插入 `id=1` 的空 runtime row。
- 按已确认的 clean cutover 清空 `bot_agent_goal`，不搬运旧 snapshot/Goal。
- 不创建 ledger UPDATE/DELETE 的应用路径；数据库权限收紧若当前部署用户模型不支持，则由 repo API 和测试保证。

### Step 4: 生成 client 并验证

Run:

```bash
pnpm db:generate
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/repo-check.test.ts
pnpm repo-check
```

Expected: Prisma generate 和两个检查均 PASS。

### Step 5: Commit

```bash
git add prisma/schema.prisma prisma/migrations/20260715193000_add_append_only_agent_ledger/migration.sql src/generated/prisma src/ops/repo-check.ts src/ops/repo-check.test.ts
git commit -m "feat: 增加追加式账本数据模型"
```

## Task 4: 实现事务化 ledger repository

**Files:**

- Create: `src/agent/agent-ledger-repo.ts`
- Create: `src/agent/agent-ledger-repo.test.ts`

### Step 1: 写 repository 失败测试

用内存 fake client 覆盖：

1. `appendMessages` 按顺序批量追加并推进 `ledgerHeadEntryId`。
2. 第二条 message create 失败时 entries 和 runtime patch 全部回滚。
3. message append 和 mailbox cursor/Goal revision 同事务。
4. `appendCompaction({ expectedHeadEntryId })` 在 head 改变时抛 `AgentLedgerHeadChangedError`。
5. checkpoint write 不在 canonical transaction 内。
6. public repo interface 没有 update/delete ledger entry 方法。

### Step 2: 运行测试确认失败

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/agent-ledger-repo.test.ts
```

Expected: FAIL，repo 尚不存在。

### Step 3: 实现 repository API

```ts
export interface AgentLedgerRepo {
  loadCanonicalState(): Promise<CanonicalAgentState>
  appendMessages(input: {
    messages: readonly DurableAgentMessage[]
    runtimePatch?: AgentRuntimePatch
  }): Promise<AppendResult>
  appendCompaction(input: {
    expectedHeadEntryId: bigint | null
    payload: CompactionLedgerPayload
  }): Promise<AppendResult>
  updateRuntime(input: {
    expectedHeadEntryId: bigint | null
    patch: AgentRuntimePatch
  }): Promise<AgentRuntimeState>
  saveCheckpoint(input: AgentCheckpointInput): Promise<void>
  loadCheckpoint(): Promise<StoredAgentCheckpoint | null>
}
```

事务内用 runtime singleton row 做 `SELECT ... FOR UPDATE` 等价锁定；重新读取数据库 ledger head，和 `expectedHeadEntryId` 比较后才 append compaction。`appendMessages` 的多条 entry 与 runtime patch 是一个 `$transaction`。只有 `lastWakeAt`、纯 capability 变更等不产生 LLM 事实的状态才走 `updateRuntime`；凡是伴随可见事实的 cursor/revision 变更必须走 `appendMessages`。

### Step 4: 运行测试

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/agent-ledger-repo.test.ts
```

Expected: PASS。

### Step 5: Commit

```bash
git add src/agent/agent-ledger-repo.ts src/agent/agent-ledger-repo.test.ts
git commit -m "feat: 实现账本原子追加仓储"
```

## Task 5: 把 checkpoint 降级为可重建 cache

**Files:**

- Create: `src/agent/agent-ledger-loader.ts`
- Create: `src/agent/agent-ledger-loader.test.ts`
- Delete: `src/agent/snapshot-repo.ts`
- Delete: `src/agent/snapshot-repo.test.ts`
- Modify: `src/agent/agent-context.ts`
- Modify: `src/agent/agent-context.test.ts`
- Modify: `src/index.ts`

### Step 1: 写 loader 失败测试

```ts
test('rebuilds when checkpoint is absent', async () => { /* canonical projection */ })
test('uses checkpoint only when head, schema and fingerprint all match', async () => { /* cache hit */ })
test('rebuilds and overwrites stale checkpoint', async () => { /* old throughEntryId */ })
test('rebuilds and overwrites corrupt checkpoint', async () => { /* invalid JSON shape */ })
test('fails closed when canonical ledger is corrupt', async () => { /* never fall back to cache */ })
```

### Step 2: 运行测试确认失败

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/agent-ledger-loader.test.ts
```

Expected: FAIL。

### Step 3: 实现 loader 和 AgentContext 收口

loader 流程：

```ts
const canonical = await repo.loadCanonicalState()
const checkpoint = await repo.loadCheckpoint()
if (isExactCheckpointHit(checkpoint, canonical)) return checkpoint.projection
const projection = projectAgentLedger(canonical)
await saveCheckpointBestEffort(projection)
return projection
```

删除 `AgentContext.replaceMessages()`。只保留一个由 Runtime Host 在 canonical commit 后调用的 `installProjection(snapshot)`；方法必须整体替换、复制输入并重新校验，业务代码不能用它跳过 ledger。

`src/index.ts` 启动改用 loader；没有 ledger 时初始化空 projection，不读取旧 snapshot。

### Step 4: 运行测试

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/agent-ledger-loader.test.ts \
  src/agent/agent-context.test.ts
```

Expected: PASS。

### Step 5: Commit

```bash
git add src/agent/agent-ledger-loader.ts src/agent/agent-ledger-loader.test.ts src/agent/agent-context.ts src/agent/agent-context.test.ts src/index.ts
git rm src/agent/snapshot-repo.ts src/agent/snapshot-repo.test.ts
git commit -m "refactor: 用账本恢复替换快照恢复"
```

## Task 6: 改成 persistence-first 的 React 轮次

**Files:**

- Modify: `src/agent/react-kernel.ts`
- Modify: `src/agent/react-kernel.test.ts`
- Modify: `src/agent/bot-loop-agent.ts`
- Modify: `src/agent/bot-loop-agent.test.ts`
- Modify: `src/agent/runtime.ts`
- Modify: `src/agent/runtime.test.ts`

### Step 1: 先写失败测试

增加三个关键行为测试：

```ts
test('does not mutate AgentContext before ledger commit succeeds', async () => {})
test('commits assistant tool calls and every ordered tool result as one batch', async () => {})
test('commits mailbox disclosure and cursor advancement atomically', async () => {})
```

再覆盖 Goal revision、`mailbox_handled` 和 active capability 的 runtime patch 与对应可见 entry 同事务。

### Step 2: 运行测试确认失败

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/react-kernel.test.ts \
  src/agent/bot-loop-agent.test.ts \
  src/agent/runtime.test.ts
```

Expected: 至少新增 persistence-first 用例 FAIL。

### Step 3: 让 kernel 返回待提交 batch

把 kernel 的直接 `context.append(...)` 改为返回：

```ts
export interface ReactRoundResult {
  messagesToAppend: AgentMessage[]
  completions: LlmCallOutput[]
  tokensUsed: number
  stopReason: ReactRoundStopReason
}
```

一个 assistant tool-call message 和它的全部 tool result 必须在 `messagesToAppend` 中连续出现。工具仍可执行副作用，但内存 ledger projection 只能在 repo commit 成功后更新。

若一个 ReAct round 内有多次 provider 调用，kernel 用 round-local `stagedMessages` 构造下一次请求；这只是未提交工作区，不能调用 `AgentContext.installProjection()`，最终由 BotLoop 一次性提交完整有序 batch。

### Step 4: 在 BotLoop 中统一提交和安装 projection

建立一个私有入口：

```ts
private async commitMessages(input: {
  messages: AgentMessage[]
  runtimePatch?: AgentRuntimePatch
}): Promise<void> {
  await this.ledgerRepo.appendMessages(input)
  await this.reloadProjectionFromCanonical()
  void this.refreshCheckpointBestEffort()
}
```

所有旧 `saveSnapshot()` 调用按语义替换成 canonical append 或纯 runtime patch；不得保留“先改 context、稍后 save”的路径。

### Step 5: 运行 focused tests

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/react-kernel.test.ts \
  src/agent/bot-loop-agent.test.ts \
  src/agent/runtime.test.ts \
  src/agent/mailbox-handled.test.ts \
  src/agent/goal-runtime.test.ts
```

Expected: PASS。

### Step 6: Commit

```bash
git add src/agent/react-kernel.ts src/agent/react-kernel.test.ts src/agent/bot-loop-agent.ts src/agent/bot-loop-agent.test.ts src/agent/runtime.ts src/agent/runtime.test.ts
git commit -m "refactor: 持久化后再推进运行上下文"
```

## Task 7: 实现 token cut、tool 原子组和 split-turn preparation

**Files:**

- Rewrite: `src/agent/compaction.ts`
- Rewrite: `src/agent/compaction.test.ts`
- Create: `src/agent/compaction-token-estimator.ts`
- Create: `src/agent/compaction-token-estimator.test.ts`

### Step 1: 写 compact preparation 表驱动测试

覆盖：

- `contextTokens <= contextWindow - reserveTokens` 不触发。
- `>` 才触发，等号不触发。
- 最近 provider `inputTokens` 加之后新增 entry 的估算。
- 从 head 反向累计到 `keepRecentTokens`。
- 优先 user-turn 边界。
- 永不从 tool result 开始 tail。
- assistant tool calls 与全部匹配 result 全留或全压。
- 单 turn 超预算时 `isSplitTurn=true`，只切合法原子组。
- repeated compaction 只摘要上次 boundary 到新 boundary 的新增历史。
- 没有任何合法切点时返回明确 `cannot_compact`，不制造坏 ledger。

### Step 2: 运行测试确认失败

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/compaction-token-estimator.test.ts \
  src/agent/compaction.test.ts
```

Expected: 旧字符 tail 行为与新断言冲突。

### Step 3: 实现纯 preparation API

```ts
export function prepareCompaction(input: {
  entries: readonly AgentLedgerEntry[]
  latestProjection: AgentLedgerProjection
  previousCompaction: CompactionLedgerEntry | null
  contextTokens: number
  contextWindowTokens: number
  reserveTokens: number
  keepRecentTokens: number
  reason: CompactionReason
  manualFocus?: string
}): CompactionPreparation | null
```

token estimator 的优先级固定：provider usage 的已知 prefix > native block/tool schema 的本地估算 > UTF-8 字节有界估算。每个估算结果标记来源，便于 metrics；切点逻辑不依赖字符数。

### Step 4: 运行测试

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/compaction-token-estimator.test.ts \
  src/agent/compaction.test.ts
```

Expected: PASS。

### Step 5: Commit

```bash
git add src/agent/compaction.ts src/agent/compaction.test.ts src/agent/compaction-token-estimator.ts src/agent/compaction-token-estimator.test.ts
git commit -m "feat: 实现Pi风格压缩切点"
```

## Task 8: 实现安全摘要序列化、previous summary 和 hooks

**Files:**

- Create: `src/agent/compaction-serialization.ts`
- Create: `src/agent/compaction-serialization.test.ts`
- Create: `src/agent/compaction-hooks.ts`
- Create: `src/agent/compaction-hooks.test.ts`
- Modify: `src/agent/compaction.ts`
- Modify: `src/agent/compaction.test.ts`
- Modify: `src/agent/untrusted-transcript.ts`
- Modify: `src/agent/untrusted-transcript.test.ts`

### Step 1: 写安全边界失败测试

必须覆盖：

1. 每个旧 tool result 最多 2,000 字符，追加确定性截断标记。
2. image 只输出 ref、描述、MIME 和尺寸，绝不输出 base64。
3. previous summary 与新增 transcript 分开标记。
4. manual focus 进入 trusted instruction，不拼进 untrusted transcript。
5. split-turn 生成“主历史摘要 + 单轮前缀摘要”。
6. 固定七个中文标题、顺序、非空和 token 上限。
7. oversized summary 只做一次有界 repair。
8. `beforeCompact` 可取消或给自定义摘要，但仍走完整校验。
9. `afterCompact` 只在 commit 后调用，失败不回滚 ledger。

### Step 2: 运行测试确认失败

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/compaction-serialization.test.ts \
  src/agent/compaction-hooks.test.ts \
  src/agent/compaction.test.ts \
  src/agent/untrusted-transcript.test.ts
```

Expected: FAIL。

### Step 3: 实现 serializer 和 hook contract

```ts
export interface CompactionHooks {
  beforeCompact?(event: BeforeCompactEvent): Promise<
    | { action: 'continue' }
    | { action: 'cancel'; reason: string }
    | { action: 'use_summary'; summary: string }
  >
  afterCompact?(event: AfterCompactEvent): Promise<void>
}
```

摘要 LLM 输入必须复用 untrusted envelope；candidate validation 先检查结构和预算，再把候选 compaction 放进完整 projection 做 integrity validation。任何一步失败都不能调用 repo append。

### Step 4: 运行测试

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/compaction-serialization.test.ts \
  src/agent/compaction-hooks.test.ts \
  src/agent/compaction.test.ts \
  src/agent/untrusted-transcript.test.ts
```

Expected: PASS。

### Step 5: Commit

```bash
git add src/agent/compaction-serialization.ts src/agent/compaction-serialization.test.ts src/agent/compaction-hooks.ts src/agent/compaction-hooks.test.ts src/agent/compaction.ts src/agent/compaction.test.ts src/agent/untrusted-transcript.ts src/agent/untrusted-transcript.test.ts
git commit -m "feat: 增加安全压缩摘要和生命周期钩子"
```

## Task 9: 把图片持久化形态改成稳定引用

**Files:**

- Modify: `src/agent/agent-context.types.ts`
- Create: `src/agent/durable-agent-message.ts`
- Create: `src/agent/durable-agent-message.test.ts`
- Modify: `src/agent/working-context.ts`
- Modify: `src/agent/working-context.test.ts`
- Modify: `src/agent/react-kernel.ts`
- Modify: `src/agent/react-kernel.test.ts`
- Create: `src/media/agent-image-ref.ts`
- Create: `src/media/agent-image-ref.test.ts`
- Modify: `src/media/image-handle.ts`
- Modify: `src/media/image-handle.test.ts`

### Step 1: 写 durable conversion 失败测试

```ts
test('replaces base64 image blocks with stable media refs before ledger append', async () => {})
test('hydrates a recent available ref for an LLM request', async () => {})
test('renders a deterministic unavailable marker when media expired', async () => {})
test('never stores base64 data in a message ledger payload', async () => {})
```

### Step 2: 运行测试确认失败

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/durable-agent-message.test.ts \
  src/agent/working-context.test.ts \
  src/agent/react-kernel.test.ts \
  src/media/agent-image-ref.test.ts \
  src/media/image-handle.test.ts
```

Expected: FAIL。

### Step 3: 实现 durable/ref 联合类型

```ts
export interface ToolResultImageRefBlock {
  type: 'image_ref'
  mediaId: string
  mediaType: string
  width?: number
  height?: number
  description?: string
}
```

规则：

- tool result 返回的 base64 在 canonical append 前写入现有 media store，再替换成 ref。
- `src/media/agent-image-ref.ts` 复用 `Media` 表、`computeMediaHash()` 和 content-addressed upsert；不新建第二套 blob 表。
- ledger 永远不保存 base64。
- `working-context` 构造 provider request 时才异步解析近期 ref。
- ref 已失效时使用包含 ref 和持久化描述的固定 text marker；不能导致 replay 失败。
- summary serializer 永远只看 ref metadata。

### Step 4: 运行测试

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/durable-agent-message.test.ts \
  src/agent/working-context.test.ts \
  src/agent/react-kernel.test.ts \
  src/media/agent-image-ref.test.ts \
  src/media/image-handle.test.ts
```

Expected: PASS，且测试搜索 ledger fixture 中不存在 `"type":"base64"`。

### Step 5: Commit

```bash
git add src/agent/agent-context.types.ts src/agent/durable-agent-message.ts src/agent/durable-agent-message.test.ts src/agent/working-context.ts src/agent/working-context.test.ts src/agent/react-kernel.ts src/agent/react-kernel.test.ts src/media/agent-image-ref.ts src/media/agent-image-ref.test.ts src/media/image-handle.ts src/media/image-handle.test.ts
git commit -m "feat: 用稳定引用持久化工具图片"
```

## Task 10: 接入 threshold、overflow 和失败恢复

**Files:**

- Modify: `src/agent/bot-loop-agent.ts`
- Modify: `src/agent/bot-loop-agent.test.ts`
- Modify: `src/agent/runtime.ts`
- Modify: `src/agent/runtime.test.ts`
- Modify: `src/agent/llm-client.ts`
- Modify: `src/agent/claude-code/llm-client.ts`
- Modify: `src/agent/claude-code/llm-client.test.ts`
- Modify: `src/agent/openai-agent/llm-client.ts`
- Modify: `src/agent/openai-agent/llm-client.test.ts`

### Step 1: 写端到端状态机失败测试

覆盖：

- threshold 超过动态阈值时在下次 LLM 调用前 compact。
- summarizer 失败不写 entry，并退避 10 分钟。
- canonical commit 失败不改变内存 context。
- checkpoint 写失败仍保留 committed ledger，下次能重建。
- head race 丢弃候选并基于新 head 重算，不误提交。
- provider context overflow 强制 compact-and-retry，绕过普通退避。
- 同一 round overflow 最多 retry 一次，第二次抛原错误。
- shutdown signal 中止未提交 summarizer。
- mailbox/rest 机器状态和 Goal continuation 经 repeated compaction 不丢失。

### Step 2: 运行测试确认失败

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/bot-loop-agent.test.ts \
  src/agent/runtime.test.ts \
  src/agent/goal-runtime.test.ts \
  src/agent/mailbox-continuity.test.ts \
  src/agent/rest-resume-reminder.test.ts
```

Expected: 新状态机用例 FAIL。

### Step 3: 实现 compact coordinator

BotLoop 私有协调器顺序固定：

1. 从 canonical projection 和最新 usage 准备 candidate。
2. 在事务外运行 `beforeCompact` 和 summarizer。
3. 校验 summary、boundary 和完整 candidate projection。
4. `appendCompaction(expectedHeadEntryId)`。
5. 从 canonical state 安装新 projection。
6. best-effort checkpoint。
7. best-effort `afterCompact`、日志和 metrics。

overflow retry 使用 round-local boolean，不能依赖全局退避；threshold 失败记录 `nextCompactionAttemptAt`，但 manual/overflow 不读取该退避。

### Step 4: 运行 focused tests

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/bot-loop-agent.test.ts \
  src/agent/runtime.test.ts \
  src/agent/goal-runtime.test.ts \
  src/agent/mailbox-continuity.test.ts \
  src/agent/rest-resume-reminder.test.ts
```

Expected: PASS。

### Step 5: Commit

```bash
git add src/agent/bot-loop-agent.ts src/agent/bot-loop-agent.test.ts src/agent/runtime.ts src/agent/runtime.test.ts src/agent/llm-client.ts src/agent/claude-code/llm-client.ts src/agent/claude-code/llm-client.test.ts src/agent/openai-agent/llm-client.ts src/agent/openai-agent/llm-client.test.ts src/agent/goal-runtime.test.ts src/agent/mailbox-continuity.test.ts src/agent/rest-resume-reminder.test.ts
git commit -m "feat: 接入压缩触发和溢出恢复"
```

## Task 11: 增加真实 owner 私聊 `/compact`

**Files:**

- Create: `src/agent/compaction-control.ts`
- Create: `src/agent/compaction-control.test.ts`
- Modify: `src/index.ts`

### Step 1: 复制 Goal control 的安全测试矩阵

测试：

- 真实 owner 的 friend private `/compact` 匹配。
- `/compact 关注工具结果` 只把后半段作为 `manualFocus`。
- 群聊、非 friend 私聊、非 owner、伪造文字都不匹配。
- startup replay 和 live ingress 都只处理一次。
- manual request 在 runtime 未 ready 时通过 startup gate 排队。
- 命令本身不追加为普通 LLM 历史消息。

### Step 2: 运行测试确认失败

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/compaction-control.test.ts
```

Expected: FAIL。

### Step 3: 实现和接线

参照 `src/agent/goal-control.ts` 的 owner 身份判定和 startup replay gate，但调用 BotLoop 的 `requestManualCompaction(focus?)`。manual focus 作为 trusted 独立字段进入 compaction preparation，长度做小型上限，不进入 untrusted transcript。

### Step 4: 运行测试

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/compaction-control.test.ts \
  src/agent/goal-runtime.test.ts \
  src/agent/runtime.test.ts
```

Expected: PASS。

### Step 5: Commit

```bash
git add src/agent/compaction-control.ts src/agent/compaction-control.test.ts src/index.ts
git commit -m "feat: 增加所有者手动压缩命令"
```

## Task 12: 提供 ledger 检查、doctor 和显式 reset

**Files:**

- Create: `src/ops/agent-ledger-check.ts`
- Create: `src/ops/agent-ledger-check.test.ts`
- Create: `scripts/agent-ledger-check.ts`
- Modify: `scripts/agent-doctor.ts`
- Modify: `scripts/reset-agent-memory.ts`
- Modify: `src/ops/reset-agent-memory.ts`
- Modify: `src/ops/reset-agent-memory.test.ts`
- Delete: `scripts/agent-snapshot-check.ts`
- Modify: `package.json`

### Step 1: 写只读检查失败测试

检查结果需要报告：

```ts
interface AgentLedgerCheckReport {
  ok: boolean
  headEntryId: string | null
  latestCompactionEntryId: string | null
  permanentEntryCount: number
  activeEntryCount: number
  projectionTokens: number
  checkpointStatus: 'hit' | 'missing' | 'stale' | 'corrupt'
  errors: Array<{ entryId?: string; code: string; message: string }>
}
```

测试合法、多次 compaction、未知 schema、ID/boundary 错误、孤立 tool result、stale checkpoint；checker 绝不能修数据。

### Step 2: 运行测试确认失败

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/ops/agent-ledger-check.test.ts \
  src/ops/reset-agent-memory.test.ts
```

Expected: FAIL。

### Step 3: 实现 scripts

- `pnpm agent:ledger-check`：只读，错误时非零退出。
- 删除 `agent:snapshot-check`，避免暗示 snapshot 仍是事实源。
- `agent:doctor` 增加 head、latest compact、active/permanent counts、projection tokens、checkpoint 状态。
- `agent:reset-memory` 明确是人工破坏性 reset：删除 ledger/runtime/checkpoint/Goal 以及现有 memory workspace，再重建空 runtime singleton。正常运行绝不调用。

### Step 4: 运行测试和 CLI 静态检查

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/ops/agent-ledger-check.test.ts \
  src/ops/reset-agent-memory.test.ts
pnpm typecheck
```

Expected: PASS。不要在开发机上真实执行 reset。

### Step 5: Commit

```bash
git add src/ops/agent-ledger-check.ts src/ops/agent-ledger-check.test.ts scripts/agent-ledger-check.ts scripts/agent-doctor.ts scripts/reset-agent-memory.ts src/ops/reset-agent-memory.ts src/ops/reset-agent-memory.test.ts package.json
git rm scripts/agent-snapshot-check.ts
git commit -m "feat: 增加账本检查和运维命令"
```

## Task 13: 更新架构文档并做全量验证

**Files:**

- Modify: `docs/AGENT_CONTEXT.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/MEMORY_ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/TECH_DEBT.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

### Step 1: 更新文档中的事实模型

明确记录：

- ledger 是唯一 LLM history source。
- runtime state 和 checkpoint 各自不是历史源。
- replay 算法、最新 compaction 解释规则、tool pair 原子性。
- clean cutover 和无旧 snapshot migration。
- 三种 trigger、预算配置、split-turn、hooks、失败恢复。
- 图片稳定引用和媒体失效行为。
- `agent:ledger-check`、doctor 和人工 reset。
- 不实现 session tree 的原因：QQ 外部副作用需要单线性时间线。

把 `AGENTS.md` 中“compaction 改写 prefix history”的旧不变量替换为“compaction 只追加 entry，projection 解释最新 boundary”；立即复制同一字节内容到 `CLAUDE.md`，再用 `cmp -s AGENTS.md CLAUDE.md` 验证。

### Step 2: 搜索旧模型残留

Run:

```bash
rg -n "BotAgentSnapshot|snapshotRepo|saveSnapshot|replaceMessages|COMPACTION_TRIGGER_TOKENS|agent:snapshot-check" \
  src scripts prisma docs .env.example package.json
```

Expected: 只剩迁移历史、设计背景或明确说明旧模型已删除的文字；运行时代码无命中。

### Step 3: 运行最小到全量验证

Run:

```bash
pnpm db:generate
pnpm typecheck
pnpm test
pnpm repo-check
git diff --check
```

Expected: 全部 PASS，`git diff --check` 无输出。

### Step 4: 人工验收关键不变量

使用测试数据库或事务回滚 fixture 验证，不启动 QQ/NapCat 或长期驻留进程：

1. 追加几轮含 tool calls 的消息。
2. 执行 manual compact。
3. 确认旧 message rows 仍存在，只有 active projection 变短。
4. 删除 checkpoint，重启 loader，确认 projection 字节相同。
5. 模拟 stale checkpoint 和第二次 compaction。
6. 运行 `pnpm agent:ledger-check`，确认 report 正常。

### Step 5: Commit docs

```bash
git add docs/AGENT_CONTEXT.md docs/ARCHITECTURE.md docs/MEMORY_ARCHITECTURE.md docs/OPERATIONS.md docs/TECH_DEBT.md
git add AGENTS.md CLAUDE.md
git commit -m "docs: 更新追加式压缩账本架构"
```

### Step 6: 完成前复核

使用 `superpowers:verification-before-completion`，以本 Task 的命令输出作为完成证据；然后使用 `superpowers:requesting-code-review` 检查设计文档中的每个目标和非目标。不要因为测试通过就跳过 schema diff、启动恢复路径和原始历史仍存在的验收。

## 实施顺序和 checkpoint

- Tasks 1–5 建立事实源和恢复底座；完成 Task 5 后做一次 code review。
- Tasks 6–10 改写运行路径和 compaction；完成 Task 10 后做第二次 code review。
- Tasks 11–13 补控制面、运维和文档；最后做全量 verification。
- 每个 Task 单独提交，发现设计冲突时停在该 Task，不用兼容 bridge 绕过。
- 当前仓库采用 `main` trunk-based development；除非用户另行要求，本计划不创建 worktree 或 feature branch。
