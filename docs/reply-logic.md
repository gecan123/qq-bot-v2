# 异步 `@` 回复逻辑

## 总体链路

```text
收到群消息
  └─ parse + media + DB insert
      └─ 是否包含 @Bot
          ├─ 否 -> 结束
          └─ 是 -> enqueue mention event
                   └─ scheduler 按群聚合
                        └─ worker 异步生成正式回复
                             └─ sender 发送 reply/at/text
```

当前运行入口：

- 入库与分发：`src/bot/core.ts`
- mention 分发：`src/conversation/dispatcher.ts`
- 群级调度：`src/conversation/scheduler.ts`
- 回复 worker：`src/conversation/worker.ts`
- 回复生成：`src/responder/reply-generator.ts`
- 发送抽象：`src/messaging/message-sender.ts`

## 一期规则

- 只处理 `@bot`
- 历史消息补拉只入库，不触发回复
- 同群使用 30 秒 merge window
- 跨群并发，同群串行
- 同一 sender 在同一 batch 内视为同一线程
- 单轮最多处理 2 个 sender 线程
- 超出部分静默进入下一轮
- 不发 ack，不发“稍等”
- 默认尽量一条发完

## worker 如何决定回复对象

对一个 `GroupConversationBatch`：

1. 先按 `senderId` 分组
2. 取最早出现的前 2 个 sender 线程处理
3. 每个 sender 线程：
   - 用该线程最后一条消息构造回复输入
   - 用该线程最早一条消息作为 reply 锚点
4. 剩余 sender 线程作为 leftovers 交回 scheduler，立即进入下一轮

这样做的目的：

- 边界规则固定，不交给 AI 决定
- 保留一点“像人一样分批回”的感觉
- 避免同群内并发回复打架

## 回复生成

`src/responder/reply-generator.ts` 只负责“生成什么内容”，不负责发送。

当前策略：

1. 优先走 `agentReply`
2. 如果 agent loop 返回非最终答案，降级到 `singleTurnReply`
3. 两条都失败则本轮跳过发送并记录日志

上下文仍然复用原有逻辑：

- `buildContext(msg, contextLimit)`
- `extractResolvedTriggerText(...)`
- `runAgentLoop(...)`

## 发送层

`src/messaging/message-sender.ts` 和 `src/messaging/segment-builder.ts` 负责把内部回复渲染为 NapCat segments。

当前只支持：

- `reply`
- `at`
- `text`

底层仍复用 `src/responder/reply-executor.ts` 的发送、重试和日志能力。

## 运维边界

- 当前 conversation queue 是内存实现，不持久化
- 进程退出后，未执行的 mention task 会丢失
- Redis 化是后续演进项
