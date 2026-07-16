# Agent Context 占用分析 CLI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新增严格只读、对 LLM context 零污染的 `pnpm agent:context`，以终端文本或版本化 JSON 展示当前 context 分类占用、模型窗口、compaction headroom 和最近 provider usage。

**Architecture:** Canonical ledger 继续是消息事实来源；CLI 用 raw read-only Prisma source 和 `projectAgentLedger` 重建 projection，再复用 `buildWorkingContextProjection` 得到当前请求视图。bot 启动时额外写一个不含正文的可丢弃 request-surface 统计快照，让离线 CLI 获得真实 system/tool 固定开销而无需创建 NapCat 或工具依赖；纯分析模块把 surface、working messages、compaction 配置和最近 usage 合成为一份版本化 report。

**Tech Stack:** TypeScript ESM、Node.js test runner、Prisma/PostgreSQL、Zod tool schema、现有 ledger projection/working-context/token estimator、pnpm。

---

实施时每个任务都使用 @superpowers:test-driven-development；完成全部任务后使用 @superpowers:verification-before-completion。保持 `main` trunk-based 工作流，不创建兼容 bridge，不触碰 `data/agent-workspace/`。

### Task 1: 提取共享 UTF-8 token 估算原语

**Files:**
- Modify: `src/agent/compaction-token-estimator.ts`
- Modify: `src/agent/compaction-token-estimator.test.ts`

**Step 1: 写失败测试**

在 `src/agent/compaction-token-estimator.test.ts` 增加：

```ts
test('estimateUtf8Tokens exposes the same bounded byte heuristic used by ledger entries', async () => {
  const { estimateUtf8Tokens } = await import('./compaction-token-estimator.js')
  assert.equal(estimateUtf8Tokens('abcd'), 1)
  assert.equal(estimateUtf8Tokens('abcd', 8), 9)
  assert.equal(estimateUtf8Tokens('你'), 1)
  assert.equal(estimateUtf8Tokens('', 8), 9)
})

test('estimateUtf8Tokens rejects invalid envelopes', async () => {
  const { estimateUtf8Tokens } = await import('./compaction-token-estimator.js')
  assert.throws(() => estimateUtf8Tokens('x', -1), /non-negative safe integer/)
})
```

**Step 2: 运行测试并确认失败**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/compaction-token-estimator.test.ts
```

Expected: FAIL，因为 `estimateUtf8Tokens` 尚未导出。

**Step 3: 写最小实现**

在 `src/agent/compaction-token-estimator.ts` 导出共享原语，并让现有 entry estimator 调用它：

```ts
export function estimateUtf8Tokens(value: string, envelopeTokens = 0): number {
  if (!Number.isSafeInteger(envelopeTokens) || envelopeTokens < 0) {
    throw new RangeError('envelopeTokens must be a non-negative safe integer')
  }
  const bytes = Buffer.byteLength(value, 'utf8')
  const contentTokens = Math.max(1, Math.ceil(bytes / UTF8_BYTES_PER_TOKEN))
  return safeAdd(contentTokens, envelopeTokens)
}
```

把 `boundedTokenEstimate(...)` 的调用替换为 `estimateUtf8Tokens(...)`，删除私有重复函数。不要改变 `MESSAGE_ENVELOPE_TOKENS`、`STRUCTURED_ENVELOPE_TOKENS` 或已有估算结果。

**Step 4: 运行测试并确认通过**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/compaction-token-estimator.test.ts src/agent/compaction.test.ts
```

Expected: PASS，且现有 compaction token 断言不变。

**Step 5: 提交**

```bash
git add src/agent/compaction-token-estimator.ts src/agent/compaction-token-estimator.test.ts
git commit -m "refactor: 复用上下文令牌估算"
```

### Task 2: 建立安全的 runtime request-surface 快照

**Files:**
- Create: `src/ops/agent-context-surface.ts`
- Create: `src/ops/agent-context-surface.test.ts`

**Step 1: 写失败测试**

创建 `src/ops/agent-context-surface.test.ts`，覆盖：

```ts
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { z } from 'zod'
import {
  buildAgentContextSurface,
  readAgentContextSurface,
  writeAgentContextSurface,
} from './agent-context-surface.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

test('surface contains only aggregate metadata and provider-facing tool names', () => {
  const surface = buildAgentContextSurface({
    provider: 'claude-code',
    model: 'claude-opus-4-7',
    contextWindowTokens: 1_000_000,
    systemPrompt: 'secret prompt body',
    tools: [{
      name: 'demo',
      description: 'secret tool description',
      schema: z.object({ token: z.string() }),
      async execute() { return { content: 'ok' } },
    }],
    generatedAt: '2026-07-16T12:00:00.000+08:00',
    pid: 123,
  })
  const raw = JSON.stringify(surface)
  assert.equal(surface.schemaVersion, 1)
  assert.equal(surface.tools.items[0]?.name, 'demo')
  assert.equal(surface.tools.totalTokens, surface.tools.items[0]?.tokens)
  assert.equal(raw.includes('secret prompt body'), false)
  assert.equal(raw.includes('secret tool description'), false)
  assert.equal(raw.includes('token'), true) // metadata key "tokens" is allowed
  assert.match(surface.fingerprint, /^[a-f0-9]{64}$/)
})

test('surface round-trips through atomic storage and missing files degrade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-context-surface-'))
  roots.push(root)
  const path = join(root, 'logs/context-surface.json')
  const surface = buildAgentContextSurface({
    provider: 'openai-agent', model: 'gpt-5.5', contextWindowTokens: 400_000,
    systemPrompt: 'prompt', tools: [], generatedAt: '2026-07-16T12:00:00.000+08:00', pid: 123,
  })
  assert.deepEqual(await readAgentContextSurface(path), { status: 'missing' })
  await writeAgentContextSurface(path, surface)
  assert.deepEqual(await readAgentContextSurface(path), { status: 'available', surface })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), surface)
})
```

另加 invalid JSON、未知 schema version 和 Claude/OpenAI tool declaration 统计不同的用例。

**Step 2: 运行测试并确认失败**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/agent-context-surface.test.ts
```

Expected: FAIL，因为模块不存在。

**Step 3: 写最小实现**

创建 `src/ops/agent-context-surface.ts`，公开以下稳定契约：

```ts
export const AGENT_CONTEXT_SURFACE_SCHEMA_VERSION = 1 as const
export const AGENT_CONTEXT_SURFACE_PATH = 'logs/context-surface.json'

export interface AgentContextSurface {
  schemaVersion: 1
  generatedAt: string
  pid: number
  provider: 'claude-code' | 'openai-agent'
  model: string
  contextWindowTokens: number
  systemIdentity: { bytes: number; tokens: number }
  botSystemPrompt: { bytes: number; tokens: number }
  tools: {
    totalBytes: number
    totalTokens: number
    items: Array<{ name: string; bytes: number; tokens: number }>
  }
  fingerprint: string
}

export type AgentContextSurfaceReadResult =
  | { status: 'available'; surface: AgentContextSurface }
  | { status: 'missing' }
  | { status: 'invalid'; error: string }
```

实现要求：

- 用 `zodToToolJsonSchema` 构造 Claude declaration；用 `zodToOpenAIStrictToolJsonSchema` 构造 OpenAI declaration。
- Claude identity 对 `CLAUDE_CODE_BILLING_HEADER` 计数；OpenAI identity 对 developer wrapper 固定结构计数。
- `bytes` 使用 `Buffer.byteLength(serialized, 'utf8')`；tokens 使用 Task 1 的 `estimateUtf8Tokens`。
- fingerprint 对 provider、model、window、完整 system prompt 和完整 provider-facing declarations 的稳定 JSON 做 SHA-256，但快照只保存 hash 和聚合数。
- tool items 保持 `tools.list()` 顺序，total 为 items 求和。
- `writeAgentContextSurface` 使用 `mkdir(dirname(path), {recursive:true})`、同目录随机临时文件、`writeFile`、`rename` 原子覆盖；失败时 best-effort 删除临时文件。
- `readAgentContextSurface` 对 ENOENT 返回 missing，对 JSON/schema 错误返回 invalid，不抛出。

不要从 request builder 复制会影响 wire bytes 的逻辑；只复用 schema converter 和固定 identity 常量。

**Step 4: 运行测试并确认通过**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/agent-context-surface.test.ts src/agent/tool-schema.test.ts
```

Expected: PASS。

**Step 5: 提交**

```bash
git add src/ops/agent-context-surface.ts src/ops/agent-context-surface.test.ts
git commit -m "feat: 记录上下文请求面统计"
```

### Task 3: 实现纯 context 分类与窗口报告

**Files:**
- Create: `src/ops/agent-context-report.ts`
- Create: `src/ops/agent-context-report.test.ts`
- Modify: `src/agent/claude-code/request.ts`
- Modify: `src/agent/claude-code/request.test.ts`

**Step 1: 先锁定 thinking replay 行为**

在 `src/agent/claude-code/request.test.ts` 为现有 active-tool-cycle 行为增加一个直接 helper 断言，然后把 `request.ts` 的私有 `shouldReplayNativeBlocks` 重命名并导出为：

```ts
export function shouldReplayClaudeNativeBlocks(
  messages: AgentMessage[],
  index: number,
  retention: ClaudeThinkingRetention,
): boolean
```

`buildClaudeCodeRequestBody` 改为调用这个导出函数，函数正文不改。测试必须证明导出前后 request body 深度相等。

**Step 2: 写报告失败测试**

创建 `src/ops/agent-context-report.test.ts`，fixture 至少包含：

```ts
const messages: AgentMessage[] = [
  { role: 'user', content: 'runtime notice' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call-1', name: 'inbox', args: { action: 'read' } }],
    nativeBlocks: [{ type: 'thinking', thinking: 'private reasoning', signature: 'sig' }],
  },
  { role: 'tool', toolCallId: 'call-1', content: [
    { type: 'text', text: 'tool text' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ] },
]
```

断言：

- system/tool surface、user、assistant call、eligible thinking、tool text、working image 为互斥分类。
- `knownTokens` 等于所有非 null category token 之和。
- surface 完整时 `estimatedCurrentInputTokens === knownTokens`，百分比和 free space 正确。
- compaction trigger 使用 `window - reserveTokens`，headroom 不为负。
- tool contributor 把 `call-1` 映射成 `inbox`。
- unknown toolCallId 归到 `unknown` contributor 并加入 warning。
- surface missing 时 system/tools 为 null，`estimateComplete=false`、`estimatedCurrentInputTokens=null`，messages 仍有报告。
- `latestProviderUsage` 原样保留，不替换本地估算。

**Step 3: 运行测试并确认失败**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/agent-context-report.test.ts src/agent/claude-code/request.test.ts
```

Expected: report 模块不存在，测试失败。

**Step 4: 写最小实现**

创建版本化报告：

```ts
export type AgentContextCategoryName =
  | 'systemIdentity'
  | 'botSystemPrompt'
  | 'visibleTools'
  | 'userAndRuntimeMessages'
  | 'assistantToolCalls'
  | 'assistantThinking'
  | 'toolResultsText'
  | 'workingImages'
  | 'assistantText'

export interface AgentContextReport {
  schemaVersion: 1
  generatedAt: string
  model: string | null
  provider: 'claude-code' | 'openai-agent' | null
  contextWindowTokens: number | null
  estimateMethod: 'local_structure_utf8_bytes'
  estimateComplete: boolean
  estimatedKnownInputTokens: number
  estimatedCurrentInputTokens: number | null
  freeTokens: number | null
  usagePercent: number | null
  compaction: {
    reserveTokens: number
    keepRecentTokens: number
    triggerTokens: number | null
    tokensUntilTrigger: number | null
    overTrigger: boolean | null
  }
  categories: Record<AgentContextCategoryName, {
    available: boolean
    tokens: number | null
    percent: number | null
  }>
  messages: {
    canonical: number
    working: number
    hydratedImages: number
    omittedImages: number
    unavailableImages: number
  }
  toolResultContributors: Array<{ toolName: string; tokens: number; resultCount: number }>
  latestProviderUsage: null | {
    ts: string
    model: string
    inputTokens: number | null
    cachedTokens: number | null
    outputTokens: number | null
  }
  surfaceStatus: 'live' | 'last_startup' | 'missing' | 'invalid'
  warnings: string[]
}
```

公开纯函数：

```ts
export function analyzeAgentContext(input: {
  canonicalMessageCount: number
  working: WorkingContextProjection
  surface: AgentContextSurface | null
  surfaceStatus: AgentContextReport['surfaceStatus']
  latestProviderUsage: AgentContextReport['latestProviderUsage']
  reserveTokens: number
  keepRecentTokens: number
  claudeThinkingRetention: ClaudeThinkingRetention
  generatedAt: string
  fallbackModel?: string
  fallbackProvider?: 'claude-code' | 'openai-agent'
  fallbackContextWindowTokens?: number
}): AgentContextReport
```

实现细则：

- user/assistant/tool 按 role 分支，只对每个序列化片段调用 `estimateUtf8Tokens` 一次。
- assistant tool calls 和 native thinking 分开序列化；Claude 只在 `shouldReplayClaudeNativeBlocks(...)` 为 true 时计 thinking，OpenAI 永远不计 native blocks。
- tool result 数组中 text 与 image 分开；image category 只计 working projection 中的 base64 image block，omitted/unavailable marker 已是 text。
- 先扫描 assistant calls 建立 `toolCallId -> name` map，再聚合 tool result contributor。
- surface 为空时三个固定分类 tokens 为 null；不得把 unavailable 当零。
- 所有算术用 safe add/clamp；百分比保留一位小数，0 total 时为 0。
- `estimatedCurrentInputTokens` 只有固定 surface 与 messages 都完整时才给值。

**Step 5: 运行测试并确认通过**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/ops/agent-context-report.test.ts \
  src/agent/claude-code/request.test.ts \
  src/agent/openai-agent/llm-client.test.ts
```

Expected: PASS，并证明 provider request body 未改变。

**Step 6: 提交**

```bash
git add src/ops/agent-context-report.ts src/ops/agent-context-report.test.ts \
  src/agent/claude-code/request.ts src/agent/claude-code/request.test.ts
git commit -m "feat: 分析当前上下文分类占用"
```

### Task 4: 增加 raw read-only 数据源与报告装配

**Files:**
- Create: `src/ops/agent-context-report-source.ts`
- Create: `src/ops/agent-context-report-source.test.ts`

**Step 1: 写失败测试**

创建 mock Prisma client，只提供以下查询：

```ts
const db = {
  botAgentLedgerEntry: { findMany: async () => entries },
  botAgentRuntimeState: { findUnique: async () => runtimeState },
  agentTokenUsage: { findFirst: async () => latestUsage },
}
```

测试：

- `createPrismaAgentContextReportSource(db).loadCanonicalState()` 返回与 `agent:ledger-check` 相同 canonical 形态。
- `loadLatestAgentChatUsage()` 只查询 `operation='agent.chat'`，按 `ts desc, id desc`，并格式化北京时间。
- source interface 不包含 checkpoint 或 mutation 方法。
- `buildCurrentAgentContextReport(...)` 调用 `projectAgentLedger` 与 `buildWorkingContextProjection`，报告 canonical/working 数正确。
- ledger integrity 错误向上抛出，不从 checkpoint、messages 表或日志回退。
- image store 的 `resolve` 被调用但 `persist` 永不调用。

**Step 2: 运行测试并确认失败**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/agent-context-report-source.test.ts
```

Expected: FAIL，因为 source 模块不存在。

**Step 3: 写最小实现**

公开：

```ts
export interface AgentContextReportSource {
  loadCanonicalState(): Promise<CanonicalAgentState>
  loadLatestAgentChatUsage(): Promise<AgentContextReport['latestProviderUsage']>
}

export function createPrismaAgentContextReportSource(
  client: AgentContextReportPrismaClient,
): AgentContextReportSource

export async function buildCurrentAgentContextReport(input: {
  source: AgentContextReportSource
  surfaceRead: AgentContextSurfaceReadResult
  surfaceStatus: AgentContextReport['surfaceStatus']
  imageRefs: AgentImageRefStore
  reserveTokens: number
  keepRecentTokens: number
  claudeThinkingRetention: ClaudeThinkingRetention
  generatedAt: string
  fallbackModel: string
  fallbackProvider: 'claude-code' | 'openai-agent'
  fallbackContextWindowTokens: number
}): Promise<AgentContextReport>
```

canonical 查询可以直接复用 `createPrismaAgentLedgerCheckSource(client).loadCanonicalState()`，但不要调用它的 checkpoint 方法。latest usage 用 Prisma `findFirst`：

```ts
client.agentTokenUsage.findFirst({
  where: { operation: 'agent.chat' },
  orderBy: [{ ts: 'desc' }, { id: 'desc' }],
  select: {
    ts: true, model: true, inputTokens: true, cachedTokens: true, outputTokens: true,
  },
})
```

装配顺序固定为 canonical read -> deterministic projection -> working projection -> latest usage -> pure analysis。任何一步都不能刷新 checkpoint 或写 DB。

**Step 4: 运行测试并确认通过**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/ops/agent-context-report-source.test.ts \
  src/ops/agent-ledger-check.test.ts \
  src/agent/working-context.test.ts
```

Expected: PASS。

**Step 5: 提交**

```bash
git add src/ops/agent-context-report-source.ts src/ops/agent-context-report-source.test.ts
git commit -m "feat: 只读装配上下文分析报告"
```

### Task 5: 实现终端渲染和 `agent:context` CLI

**Files:**
- Create: `src/ops/agent-context-report-render.ts`
- Create: `src/ops/agent-context-report-render.test.ts`
- Create: `scripts/agent-context.ts`
- Modify: `package.json`

**Step 1: 写渲染与参数失败测试**

创建 `src/ops/agent-context-report-render.test.ts`，验证：

```ts
test('default rendering shows model, estimate, categories, free space, and compaction headroom', () => {
  const text = renderAgentContextReport(fixtureReport)
  assert.match(text, /Context Usage/)
  assert.match(text, /claude-opus-4-7/)
  assert.match(text, /Estimated current/)
  assert.match(text, /Visible tools/)
  assert.match(text, /Free space/)
  assert.match(text, /Compaction trigger/)
})

test('parseAgentContextArgs accepts only --json', () => {
  assert.deepEqual(parseAgentContextArgs([]), { json: false })
  assert.deepEqual(parseAgentContextArgs(['--json']), { json: true })
  assert.deepEqual(parseAgentContextArgs(['--', '--json']), { json: true })
  assert.throws(() => parseAgentContextArgs(['--watch']), /unknown argument/)
})
```

另测 unavailable 分类显示 `n/a`、大数字 compact formatting、非 TTY 输出不依赖 ANSI。

**Step 2: 运行测试并确认失败**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/agent-context-report-render.test.ts
```

Expected: FAIL，因为 renderer 不存在。

**Step 3: 写 renderer**

`src/ops/agent-context-report-render.ts` 导出：

```ts
export function parseAgentContextArgs(args: string[]): { json: boolean }
export function renderAgentContextReport(report: AgentContextReport): string
export function renderCompactTokens(value: number): string
```

默认文本使用固定标签、空格对齐和可选 Unicode bar，不使用 ANSI color。category label 固定映射，不把内部 key 直接暴露为 UI。warnings 放在末尾，每条一行。

**Step 4: 写 CLI 薄入口**

创建 `scripts/agent-context.ts`：

```ts
import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { config } from '../src/config/index.js'
import { prisma } from '../src/database/client.js'
import { agentImageRefStore } from '../src/media/agent-image-ref.js'
import {
  AGENT_CONTEXT_SURFACE_PATH,
  readAgentContextSurface,
} from '../src/ops/agent-context-surface.js'
import {
  buildCurrentAgentContextReport,
  createPrismaAgentContextReportSource,
} from '../src/ops/agent-context-report-source.js'
import {
  parseAgentContextArgs,
  renderAgentContextReport,
} from '../src/ops/agent-context-report-render.js'
import { formatBeijingIso } from '../src/utils/beijing-time.js'

const options = parseAgentContextArgs(process.argv.slice(2))

try {
  await prisma.$connect()
  const surfaceRead = await readAgentContextSurface(AGENT_CONTEXT_SURFACE_PATH)
  const surfaceStatus = await classifySurfaceStatus(surfaceRead, '.bot.pid', readFile, process.kill)
  const report = await buildCurrentAgentContextReport({
    source: createPrismaAgentContextReportSource(prisma),
    surfaceRead,
    surfaceStatus,
    imageRefs: agentImageRefStore,
    reserveTokens: config.compaction.reserveTokens,
    keepRecentTokens: config.compaction.keepRecentTokens,
    claudeThinkingRetention: config.llm.claudeThinking.retention,
    generatedAt: formatBeijingIso(new Date()),
    fallbackModel: config.llm.defaultModel,
    fallbackProvider: config.llm.defaultProvider,
    fallbackContextWindowTokens: config.llm.contextWindowTokensByModel[config.llm.defaultModel]!,
  })
  process.stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${renderAgentContextReport(report)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: 'agent_context_report_failed',
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
```

把 `classifySurfaceStatus` 做成 surface 模块中的可测试 helper；实际实现对 missing/invalid 原样映射，对 pid file 与 snapshot pid 匹配且 `kill(pid, 0)` 成功返回 live，其余 available 返回 last_startup。处理 EPERM 为 live，ESRCH 为 last_startup。

在 `package.json` 增加：

```json
"agent:context": "tsx scripts/agent-context.ts"
```

**Step 5: 运行测试和静态验证**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/ops/agent-context-report-render.test.ts \
  src/ops/agent-context-surface.test.ts
pnpm typecheck
```

Expected: PASS；typecheck 无错误。

不要在测试中运行真实 CLI，因为它会连接开发数据库；CLI 的 parser、renderer、source 和 orchestrator 已分别使用纯测试覆盖。

**Step 6: 提交**

```bash
git add src/ops/agent-context-report-render.ts src/ops/agent-context-report-render.test.ts \
  src/ops/agent-context-surface.ts src/ops/agent-context-surface.test.ts \
  scripts/agent-context.ts package.json
git commit -m "feat: 增加上下文占用分析命令"
```

### Task 6: 在 runtime 启动后写入真实 surface 统计

**Files:**
- Modify: `src/index.ts`
- Modify: `src/ops/agent-context-surface.test.ts`

**Step 1: 写 wiring helper 失败测试**

不要导入有启动副作用的 `src/index.ts`。在 surface 测试中新增一个针对 `writeRuntimeAgentContextSurface` 的用例，传入假的 runtime：

```ts
await writeRuntimeAgentContextSurface({
  path,
  provider: 'claude-code',
  model: 'claude-opus-4-7',
  contextWindowTokens: 1_000_000,
  systemPrompt: 'runtime prompt',
  tools: [tool],
  now: () => new Date('2026-07-16T04:00:00.000Z'),
  pid: 123,
})
const stored = await readAgentContextSurface(path)
assert.equal(stored.status, 'available')
assert.equal(stored.status === 'available' && stored.surface.tools.items[0]?.name, 'demo')
```

**Step 2: 运行测试并确认失败**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/agent-context-surface.test.ts
```

Expected: FAIL，因为 `writeRuntimeAgentContextSurface` 尚不存在。

**Step 3: 实现 helper 并接线**

在 surface 模块实现：

```ts
export async function writeRuntimeAgentContextSurface(input: {
  path: string
  provider: 'claude-code' | 'openai-agent'
  model: string
  contextWindowTokens: number
  systemPrompt: string
  tools: Tool[]
  now?: () => Date
  pid?: number
}): Promise<AgentContextSurface> {
  const surface = buildAgentContextSurface({
    ...input,
    generatedAt: formatBeijingIso((input.now ?? (() => new Date()))()),
    pid: input.pid ?? process.pid,
  })
  await writeAgentContextSurface(input.path, surface)
  return surface
}
```

在 `src/index.ts` 创建 `runtime` 后、进入主循环前调用：

```ts
try {
  const surface = await writeRuntimeAgentContextSurface({
    path: AGENT_CONTEXT_SURFACE_PATH,
    provider: config.llm.defaultProvider,
    model: config.llm.defaultModel,
    contextWindowTokens: config.llm.contextWindowTokensByModel[config.llm.defaultModel]!,
    systemPrompt: runtime.systemPrompt,
    tools: runtime.tools.list(),
  })
  log.info({ path: AGENT_CONTEXT_SURFACE_PATH, fingerprint: surface.fingerprint }, 'context surface 已写入')
} catch (error) {
  log.warn({ error, path: AGENT_CONTEXT_SURFACE_PATH }, 'context surface 写入失败')
}
```

这是 best-effort 运维快照；失败不能阻止 bot 启动。不要把 snapshot 传给 `AgentContext`、ledger loader 或 compaction。

**Step 4: 运行 focused 回归**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/ops/agent-context-surface.test.ts \
  src/agent/runtime.test.ts \
  src/agent/claude-code/request.test.ts \
  src/agent/openai-agent/llm-client.test.ts
pnpm typecheck
```

Expected: PASS；request builder 的既有 byte/shape 断言不变。

**Step 5: 提交**

```bash
git add src/index.ts src/ops/agent-context-surface.ts src/ops/agent-context-surface.test.ts
git commit -m "feat: 启动时记录上下文请求面"
```

### Task 7: 文档、只读验证与最终回归

**Files:**
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/README.md` only if a new direct link is necessary; otherwise leave unchanged

**Step 1: 更新运维文档**

在 `docs/OPERATIONS.md` 的常用命令加入：

```bash
pnpm agent:context
pnpm agent:context -- --json
```

在“Agent 反馈”增加一条，明确：

- canonical ledger 和 runtime state 是 context 消息来源。
- `logs/context-surface.json` 只是最近一次启动的 system/tool 聚合统计，不参与 replay。
- 分类值是本地估算，latest provider usage 是独立实测。
- 命令不调用 LLM、不启动外部服务、不写 DB/checkpoint/runtime，因此不会污染 LLM context。

**Step 2: 运行 focused test suite**

Run:

```bash
node_modules/.bin/tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/compaction-token-estimator.test.ts \
  src/agent/working-context.test.ts \
  src/agent/claude-code/request.test.ts \
  src/agent/openai-agent/llm-client.test.ts \
  src/ops/agent-context-surface.test.ts \
  src/ops/agent-context-report.test.ts \
  src/ops/agent-context-report-source.test.ts \
  src/ops/agent-context-report-render.test.ts \
  src/ops/agent-ledger-check.test.ts
```

Expected: PASS，0 failures。

**Step 3: 运行仓库级验证**

Run:

```bash
pnpm typecheck
pnpm repo-check
git diff --check
```

Expected: 全部通过。

**Step 4: 做一次真实只读 smoke test**

仅当当前 Postgres 可用且 bot 至少成功启动过一次时运行：

```bash
pnpm agent:context
pnpm agent:context -- --json
```

Expected:

- 文本报告可读，JSON 可被 `JSON.parse`。
- 两次命令前后 `bot_agent_ledger_entries` head、`bot_agent_runtime_state` 和 `bot_agent_checkpoint.updated_at` 不变。
- 没有启动 NapCat/browser/MCP 或新增 token usage。

若本地 DB 或 surface 不可用，跳过 smoke test并在交付中明确说明；不能为了验证启动真实外部服务。

**Step 5: 检查变更边界**

Run:

```bash
git status --short
git diff --stat
git diff -- docs/OPERATIONS.md package.json src/index.ts src/agent/compaction-token-estimator.ts \
  src/agent/claude-code/request.ts src/ops scripts/agent-context.ts
```

Expected: 只有计划内文件；`data/agent-workspace/`、Prisma schema、prompt bytes 和无关用户文件未变。

**Step 6: 提交文档和最终整理**

```bash
git add docs/OPERATIONS.md
git commit -m "docs: 说明上下文分析命令"
```

如果前面提交后产生了仅为 lint/typecheck 的必要机械修正，另用：

```bash
git add <仅相关文件>
git commit -m "chore: 完善上下文分析验证"
```

不要 squash；保留可审查的小提交。
