# 结构化工具结果与事件设计

## 目标

消除 runtime 和 Agent 对自然语言标记、展示文本及被截断 JSON 的依赖。控制信号、执行状态、跨工具 ID、引用和分页参数使用稳定结构；摘要、评论、skill 正文等语义内容继续保留自然语言。

本项目不提供旧结果格式兼容层。已有 snapshot 中的历史文本保持原样；新工具结果和新事件直接使用目标契约。

## 总体架构

采用双层结果契约：

```ts
interface ToolExecutionResult {
  content: ToolResultContent
  outcome?: {
    ok: boolean
    code?: string
    error?: string
  }
  control?: {
    type: 'pause'
  }
}
```

`content` 是进入 AgentContext、供 LLM 使用的内容。机器可操作的结果使用合法 JSON；大段语义正文作为 JSON 字段中的字符串。`outcome` 和 `control` 仅供 runtime、审计和循环控制使用，不进入 prompt，不参与 replay。

工具执行器记录审计结果时优先读取 `outcome`。没有 `outcome` 的旧式内部工具可暂时回退到现有 content 分类逻辑，但本次修改覆盖的工具必须显式提供 outcome。BotLoop 通过 `control.type` 判断暂停，不再解析中文内容前缀。

## 各模块目标模型

### Pause

`pause` 的 LLM 内容返回 JSON，包含 `ok`、`status=elapsed|interrupted`、`durationSeconds`、`elapsedMs` 和 `intention`。执行结果同时携带 `control: { type: 'pause' }`。BotLoop 只读取 control。

### 外部内容

`fetch_url` 返回 `{ok, source, url, status, title, summary, fallback, truncated, error}`。Reddit list 返回结构化 `items[]`，每项保留 `title`、`url`、`imageUrl`、`summary` 等字段；post 返回 `title`、`imageUrl`、`comments[]`。`web_search` 返回结构化 `results[]`。

所有外部结果先逐字段裁剪、再按条目数量缩减，最后序列化。禁止对序列化后的 JSON 直接切片。失败统一返回 `ok:false`、稳定 `code` 和 `error`，并在 outcome 中反映失败。

### Runtime 事件

mailbox notification 使用 JSON 字符串，包含 `event`、`mailbox`、`priority`、来源、`count`、row 范围、sender 数量、时间范围和可直接传给 inbox 的 `readArgs`。后台任务完成事件使用 JSON 字符串，包含 `event`、`taskId`、`toolName`、`ok`、`elapsedMs`、`description` 和 `summary`。

### 表情包

收藏结果返回合法 JSON：`{ok, action, sticker, pool}`。`sticker` 和 `pool[]` 都提供 `mediaId` 与 `mediaRef=media:<id>`。compaction 后注入的表情包状态也使用有界 JSON，不再使用 `#<mediaId>` 展示约定。

### 命令工具

`workspace_bash` 与 OpenBB 成功和失败结果统一使用 `{ok, exitCode, format, content, stderr, truncated, error}` envelope。命令实际输出仍是文本或 JSON/CSV 文本，不在本层尝试理解任意业务格式。

## 数据边界与 replay

- `outcome/control` 是瞬时 runtime 元数据，不保存进 AgentContext。
- `content` 仍按现有 tool result 路径 append，并满足确定性和有界输出要求。
- mailbox 和后台任务事件作为 user message append，因此 JSON 字节必须由稳定字段顺序和稳定序列化产生。
- 不从日志、side table 或可变状态重建历史结果。
- compaction 不改变 assistant tool call 与对应 tool result 的原子性。

## 错误处理

- 所有可预期失败返回 `outcome.ok=false`，并在 LLM JSON 中返回相同语义的 `ok:false`、`code` 和 `error`。
- 工具抛出的未预期异常由 executor 生成结构化失败 outcome 和 JSON content。
- 结果裁剪必须保留合法 JSON，以及 `ok/code/error/truncated` 等关键字段。
- 图片 block 继续使用现有 structured content；伴随的 text block 使用合法 JSON。

## 验证策略

- 单元测试验证 pause 控制不依赖中文文案。
- 工具执行器测试验证 outcome 优先于 content 分类，异常结果带结构化 outcome。
- 外部内容测试验证成功/失败 JSON 可解析，且上限内裁剪后仍有效。
- 事件测试验证精确结构与确定性序列化。
- 表情包测试验证 collect、list/search/random 和 compaction 注入共享 `mediaRef` 契约。
- 命令工具测试验证 envelope、退出码和 truncated 字段。
- 最终运行 focused tests、完整 `pnpm test`（环境允许时）、`pnpm typecheck` 和 `pnpm repo-check`。
