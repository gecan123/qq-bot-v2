# Agent Context 快照分析简化设计

## 目标

提供严格只读、不会向 LLM context 追加消息的 `pnpm agent:context`。它用于快速判断当前 canonical context 的大致组成、窗口余量、compaction headroom 和主要 tool result 来源。

本工具是诊断快照，不追求与某一次 provider wire request 逐字节一致。

## 非目标

- 不实现 Claude Code `/context` 的逐 token 精确复刻。
- 不为了报告启动 bot、NapCat、browser、MCP、scheduler 或 LLM。
- 不读取 `messages` 表重建 prompt。
- 不刷新 checkpoint，不写 ledger、runtime state、数据库或图片。
- 不兼容旧 surface schema；下次 bot 启动会自然写入新快照。

## 方案选择

采用“小型固定面快照 + CLI 只读重建 + 单遍近似估算”。

没有采用：

- provider request 精确重建与最大余数分摊：复杂度高，而且 system/tools 本身仍是启动快照，会制造假精确。
- PID 存活检测：快照时间已经足够表达新旧，用户接受 last-startup snapshot。
- 完整 runtime 注入测试框架：底层 source、projection、estimator 和 renderer 的纯测试已经覆盖主要风险。

## 数据流

```text
bot startup
  -> 计算 system identity / bot prompt / visible tools 的近似 token
  -> 原子写 logs/context-surface.json

pnpm agent:context
  -> raw read canonical ledger + runtime state
  -> projectAgentLedger
  -> buildWorkingContextProjection
  -> 单遍遍历 AgentMessage 分类估算
  -> 读取最近 agent.chat provider usage
  -> 输出文本或 JSON
```

surface、usage 和报告都只是运维证据，不能反向进入 AgentContext、replay、system prompt 或 compaction。

## 固定面快照

surface schema v2 只保存报告真正使用的字段：

```ts
interface AgentContextSurface {
  schemaVersion: 2
  generatedAt: string
  provider: 'claude-code' | 'openai-agent'
  model: string
  contextWindowTokens: number
  fixedTokens: {
    systemIdentity: number
    botSystemPrompt: number
    visibleTools: number
  }
}
```

不再保存 bytes、逐工具 items、fingerprint 或 pid。写入仍使用同目录临时文件加 rename，保证读者不会看到半文件。

system identity、prompt 和 tool declarations 使用 UTF-8 bytes / 4 的共享启发式估算。tool declarations 继续使用当前 provider 的 schema converter，但只保存合计。

读取结果只有：

- `available`
- `missing`
- `invalid`

`generatedAt` 直接说明快照时间，不判断进程是否仍存活。

## 消息分类

CLI 直接遍历 working `AgentMessage[]`：

- user message -> `userAndRuntimeMessages`
- assistant text -> `assistantText`
- assistant tool calls -> `assistantToolCalls`
- 可 replay 的 Claude native blocks -> `assistantThinking`
- tool result 非图片内容 -> `toolResultsText`
- tool result 图片 -> `workingImages`

每个分类对自身的结构化 JSON 使用共享 UTF-8 估算。它们不再保证等于 provider message JSON 的精确序列化总量。

tool result 仍按 `toolCallId` 映射回工具名并给出 top contributors。图片继续使用 working projection，因为 base64 是否实际 hydrated 会显著影响占用。

## 报告模型

report schema v2 删除可推导字段：

```ts
interface AgentContextReport {
  schemaVersion: 2
  generatedAt: string
  provider: 'claude-code' | 'openai-agent' | null
  model: string | null
  contextWindowTokens: number | null
  estimatedSnapshotTokens: number | null
  usagePercent: number | null
  freeTokens: number | null
  categories: Record<AgentContextCategoryName, number | null>
  compaction: {
    triggerTokens: number | null
    tokensUntilTrigger: number | null
    reserveTokens: number
    keepRecentTokens: number
  }
  messages: {
    canonical: number
    working: number
    hydratedImages: number
    omittedImages: number
    unavailableImages: number
  }
  toolResultContributors: Array<{
    toolName: string
    tokens: number
    resultCount: number
  }>
  latestProviderUsage: ProviderUsage | null
  surfaceStatus: 'available' | 'missing' | 'invalid'
  warnings: string[]
}
```

当 surface 缺失或损坏时，三个固定分类为 `null`，`estimatedSnapshotTokens` 也为 `null`；消息分类仍照常计算并出现在 JSON 中。

## Canonical 读取

canonical raw loader 与 `agent:ledger-check` 共用，避免重复定义 ledger/runtime 映射。

bot 正在提交时可能出现一次瞬时 head 不一致。报告装配在 projection 失败后完整重读一次；第二次仍失败则 fail closed。这里不引入事务、锁或退避策略。

## CLI

默认文本：

```bash
pnpm agent:context
```

机器 JSON：

```bash
pnpm --silent agent:context -- --json
```

CLI production helper只返回待输出字符串。配置和 Prisma 使用动态 import，保证初始化错误落入脚本的统一 JSON error boundary。连接后用 `try/finally` 断开数据库；输出发生在 helper resolve 之后。

## 必须保留的不变量

- canonical ledger 是唯一持久 LLM history source。
- working projection 决定图片 hydration。
- CLI 不写 DB、checkpoint、runtime、ledger 或 workspace。
- surface 不参与 replay。
- canonical 损坏必须失败，不能回退到 messages、checkpoint 或日志。
- 报告不输出 prompt 正文、message 正文、tool args、schema 或 base64。

## 验证

- surface v2 缺失、损坏、原子覆盖。
- 单遍分类和 contributor。
- Claude thinking mode/retention。
- canonical projection 一次重读。
- 文本与 JSON 输出。
- CLI 初始化错误不泄漏 stack。
- 全仓测试、typecheck、repo-check 和 diff check。
