# 回复前等待媒体描述就绪

## 问题

Bot 被 @ 时，`buildContext()` 通过 `resolveMessage()` 从 DB 拉取媒体描述。但如果图片/视频刚刚到达，`generate-description` 队列任务还未完成，`resolveMessage()` 会看到 `description = null`，最终输出 `[图片]` 占位符，LLM 无法理解媒体内容。

根本原因：描述生成是异步后台任务，回复流程不等它完成。

## 设计目标

- 回复前确保最近 N 条消息的媒体描述已写入 DB
- 超时后降级为 `[图片]`，不阻塞回复
- 队列任务和 on-demand 路径不产生重复 LLM 调用

## 竞态分析

队列 job 和 on-demand 路径可能同时对同一 `mediaId` 读到 `description = null`，各自调 LLM。结果是两次调用，后写覆盖前写，数据不损坏但浪费调用。

**解法：进程内 in-flight Promise Map（模块级单例）**

```
inFlight: Map<mediaId, Promise<void>>

第一个调用者：看不到 in-flight → 创建 Promise → 存入 Map → 调 LLM → 写 DB → 删 Map
第二个调用者（并发）：看到 in-flight → await 同一 Promise → 复用结果，零重复调用
第二个调用者（稍后）：in-flight 已清空 → doGenerate() 读 DB → description 已存在 → 直接返回
```

进程内互斥，无需数据库锁。

## 改动方案

### 1. `src/jobs/generate-description.ts`

提取核心逻辑为 `generateDescriptionForMedia(mediaId)` 导出函数，内部维护 `inFlight: Map<number, Promise<void>>`。

`handleGenerateDescription`（队列 handler）改为调用此函数，逻辑不变。

### 2. 新文件 `src/responder/ensure-descriptions.ts`

```ts
// ensureDescriptions(messages, timeoutMs):
// 1. 从 segments 找出所有 referenceId
// 2. 查 DB，筛出 description = null 的 mediaId
// 3. 并行调 generateDescriptionForMedia() for each
// 4. Promise.allSettled() 包裹，外层 Promise.race(timeout) 超时降级
```

### 3. `src/responder/context-builder.ts`

`buildContext()` 在 `resolveMessage()` 循环前，先对最近 N 条消息调 `ensureDescriptions()`。

### 4. `src/config/index.ts` + `.env.example`

新增两个可选环境变量（有默认值）：
- `REPLY_MEDIA_WAIT_N`（默认 5）：等最近几条消息里的媒体
- `REPLY_MEDIA_TIMEOUT_MS`（默认 5000）：超时降级时间（毫秒）

`.env.example` 写中文注释说明用途。

## 数据流

```
at-mention 触发
  ↓
buildContext()
  ↓
getRecentGroupMessages(groupId, contextLimit)  ← 拉全部历史
  ↓
ensureDescriptions(recentN 条, timeoutMs)       ← 新增：并行等待未就绪描述
  ↓  (超时或全部完成)
resolveMessage() × N                            ← 现有：从 DB 读描述注入
  ↓
segmentsToText() × N
  ↓
生成 context 字符串 → LLM
```

## 变更文件

| 文件 | 变更类型 |
|------|---------|
| `src/jobs/generate-description.ts` | 重构：提取 `generateDescriptionForMedia()`，加 in-flight Map |
| `src/responder/ensure-descriptions.ts` | 新增 |
| `src/responder/context-builder.ts` | 修改：在 resolveMessage 前调 ensureDescriptions |
| `src/config/index.ts` | 修改：加两个可选配置项 |
| `.env.example` | 修改：加两行带中文注释的配置 |

## 验证标准

1. 图片刚到立刻 @bot → 回复中包含图片描述，不是 `[图片]`
2. 超时场景（LLM 极慢）→ 超时后降级为 `[图片]`，不报错，正常回复
3. 队列和 on-demand 同时跑同一 mediaId → 只有一次 LLM 调用（日志验证）
4. 旧消息（description 早已就绪）→ `ensureDescriptions` 无额外 LLM 调用，直接返回
