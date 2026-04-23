# 异步 `@` 回复逻辑

## 总体链路

```text
收到群消息
  └─ parse + media + DB insert
      └─ root runtime ingress
          └─ 是否包含 @Bot
              ├─ 否 -> 只推进 runtime unread / continuity
              └─ 是 -> enqueue passive mention event
                       └─ root runtime 按群串行执行
                            └─ passive mention processor 生成正式回复
                                 └─ assistant_turns 投递并回写 continuity
```

当前运行入口：

- 入库与分发：`src/bot/core.ts`
- root runtime：`src/runtime/root-runtime.ts`
- 被动 mention processor：`src/runtime/passive-mention-processor.ts`
- 回复生成：`src/responder/reply-generator.ts`
- 发送抽象：`src/messaging/message-sender.ts`

## 一期规则

- 只处理 `@bot`
- 历史消息补拉进入 runtime ingress，但不触发回复
- 跨群并发，同群串行
- 同一 sender 在同一 batch 内视为同一线程
- 单轮最多处理 2 个 sender 线程
- 超出部分静默进入下一轮
- 不发 ack，不发“稍等”
- 默认尽量一条发完

## passive processor 如何决定回复对象

对一个 `GroupConversationBatch`：

1. 先按 `senderId` 分组
2. 取最早出现的前 2 个 sender 线程处理
3. 每个 sender 线程：
   - 用该线程最后一条消息构造回复输入
   - 用该线程最早一条消息作为 reply 锚点
4. 剩余 sender 线程作为 leftovers 交回 root runtime，立即进入下一轮

这样做的目的：

- 边界规则固定，不交给 AI 决定
- 保留一点“像人一样分批回”的感觉
- 避免同群内并发回复打架

## 回复生成

`src/responder/reply-generator.ts` 只负责“生成什么内容”，不负责发送。

当前策略：

1. 被动 `@` 回复统一走 agent reply
2. 若 agent loop 没拿到最终答案，则本轮跳过发送并记录日志

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

底层通过 `assistant_turns` + `src/conversation/assistant-turn-delivery.ts` 处理发送、重试和恢复。

## 运维边界

- root runtime snapshot 已持久化，但被动 mention queue 仍是进程内队列
- 进程退出后，未实际生成为 `assistant_turns` 的 mention event 仍会依赖 `messages` 重放重新进入 runtime
- 启动恢复会先 restore snapshot，再 replay ingress delta，再恢复可发送 `assistant_turns`
