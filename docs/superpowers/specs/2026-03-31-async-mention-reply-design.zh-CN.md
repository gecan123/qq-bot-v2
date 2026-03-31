# QQ Bot V2 异步 @ 回复任务化设计（中文版）

日期：2026-03-31  
仓库：`qq-bot-v2`  
状态：已确认设计（实施前）

## 1. 目标与范围

本设计面向 `qq-bot-v2` 的 `@bot` 回复链路，目标是将“消息存储”和“回复用户”彻底解偶，让 `@回复` 变成独立任务。

核心目标：
- 收到群消息后，主链路只负责解析、媒体登记、消息落库。
- `@bot` 不再在消息处理链路里直接回复，而是创建独立任务。
- 任务系统支持跨群并发、群内串行。
- 同一群 30 秒窗口内的多个 `@` 可以聚合后统一处理。
- 第一版使用内存队列；后续可以替换为 Redis，而不改业务层接口。

一期范围内：
- 只处理 `@reply` 这一类任务。
- 只做正式回复，不做“我看下/稍等”之类的 ack。
- `@` 事件必须实时进入任务系统。
- 第一版默认尽量一条发完；必要时允许最多两条。
- 会话边界与分批规则由代码规则决定，不交给 AI 判断。

一期范围外：
- 主动回复群友话题。
- 主动浏览论坛并回群分享。
- 任务持久化表。
- Redis 队列实现。
- AI 决定会话聚合、拆分或回复条数。

## 2. 已锁定决策

以下决策已确认：

1. `@回复` 要从消息处理主链路中剥离，成为独立任务。
2. 消息存储和回复执行完全解偶。
3. 第一版队列采用内存实现，后续迁移到 Redis。
4. 调度模型为“跨群并发、群内串行”。
5. 同群 `@` 聚合窗口固定为 30 秒。
6. 同群同窗口内的 `@` 先按规则聚合，再交给 worker 执行。
7. 会话边界、拆分与分批由规则决定，不让 AI 自主决定。
8. 第一版不做 ack；只发送正式回复。
9. 第一版默认尽量一条发完；必要时最多两条。
10. 当同一轮问题过多时，允许静默分批；不额外解释“我稍后再回”。

## 3. 推荐架构

采用“实时触发事件 + 群级任务调度 + 独立回复执行”的方案。

核心思想：
- NapCat 负责把消息送进系统。
- Bot 主链路负责存储事实，不负责直接回复。
- `@bot` 只负责生成一条待处理任务。
- 调度器按群维护 mailbox，同群 30 秒内的新 `@` 先聚合，再统一生成回复。
- 回复发送通过独立接口完成，避免 worker 直接依赖 NapCat 原始调用细节。

### 3.1 总体数据流

```text
NapCat 消息
-> parseMessage
-> persistMediaReferences
-> insertMessage
-> detect @bot
-> enqueue mention-reply job
-> scheduler/group mailbox 聚合 30 秒窗口
-> worker 取该群当前会话
-> buildContext + LLM/Agent
-> MessageSender 发送正式回复
```

### 3.2 组件划分

1. Message Ingress
- 继续由 `src/bot/core.ts` 驱动。
- 责任仅限：取消息、解析、登记媒体、落库、检测是否 `@bot`。

2. Mention Task Dispatcher
- 负责将 `@bot` 消息转换成任务事件并送入队列。
- 不负责生成回复内容。

3. Group Conversation Scheduler
- 以群为单位聚合任务。
- 实现“跨群并发、群内串行”。
- 管理 30 秒聚合窗口。

4. Conversation Worker
- 真正执行某群某一轮会话的回复生成。
- 从数据库读取上下文。
- 调用现有 `buildContext` / `agent loop` / 单轮回复能力。

5. Message Sender
- 负责把回复内容转成 NapCat 可发送消息。
- 统一处理 reply、at、普通文本、重试等逻辑。

## 4. 队列与调度设计

### 4.1 为什么第一版只用内存队列

内存队列足够满足一期目标：
- 先验证“解偶”是否合理。
- 先验证调度行为是否拟人。
- 避免一开始把复杂度花在 Redis 基础设施上。

已知接受的限制：
- 进程重启会丢失未处理任务。
- 不支持多进程共享任务。
- 不保证崩溃恢复。

这是一期可接受的工程折中。

### 4.2 队列抽象要求

业务层不能直接依赖内存实现，必须依赖抽象接口。

建议新增：
- `src/queue/conversation-queue.ts`
- `src/queue/conversation-memory-queue.ts`

接口职责至少包括：
- `enqueueMention(event)`
- `start()`
- `stop()`

如果后续需要 Redis，替换为：
- `src/queue/conversation-redis-queue.ts`

但上层 `dispatcher / scheduler / worker` 不应感知底层实现差异。

### 4.3 并发模型

并发策略固定如下：

- 跨群并发：允许
- 群内并发：禁止

含义是：
- 群 A 和群 B 可以同时处理
- 群 A 内同一时刻只能有一个会话 worker 在执行
- 群 A 的新 `@` 在当前 worker 运行时，只能继续进入该群的待聚合窗口，不能起第二个 worker

这样做的原因：
- 防止群内上下文竞争
- 防止同群回复乱序
- 防止 bot 同一时间连续刷屏

### 4.4 聚合窗口

固定聚合窗口：30 秒。

推荐行为：
- 某群收到第一条 `@` 时，开启该群一个 30 秒窗口。
- 30 秒内该群新增的 `@` 都追加到同一轮候选集合。
- 30 秒到期后，由调度器将这一轮候选集合交给该群 worker。

一期不让 AI 决定是否合并；只按规则合并。

## 5. 会话边界与分批规则

### 5.1 原则

群级可以聚合，用户级不能乱串话。

这意味着：
- 可以把同群 30 秒内多条 `@` 放进同一轮处理。
- 但回复内容组织时，不能完全交给 AI 自由决定“是不是一个问题”。

### 5.2 第一版规则

1. 同一发送者 + 30 秒内连续 `@`
- 默认视作同一子会话。

2. 不同发送者
- 默认视作不同子问题。

3. 同一轮内的处理上限
- 最多处理 2 个发送者或 2 个明确子问题。

4. 超过上限时
- 静默分批，不额外解释。
- 当前轮先处理更早进入窗口的子问题。
- 剩余子问题留到下一轮。

### 5.3 为什么不用 AI 决定

第一版不让 AI 决定会话边界，原因如下：
- 群聊噪声高，模型容易串话。
- 一旦误把两个人的问题混成一个答案，体验会很差。
- 规则更稳定，也更容易 debug。

AI 在一期只负责“怎么回答”，不负责“这是不是同一轮问题”。

## 6. 回复生成策略

### 6.1 第一期策略

第一版只做正式回复：
- 不发 ack
- 不发“我看下”
- 不发“稍等”

worker 在真正执行时，直接生成正式回答。

### 6.2 回复条数规则

第一版默认“尽量一条发完”，但允许最多两条。

具体规则：
- 默认：一条
- 允许两条：
  - 同一轮内要分别回应两个不同用户
  - 单条过长，需要拆成“结论 + 补充”
- 禁止三条以上

### 6.3 分批时的表现

当同一轮问题过多时：
- bot 先回当前轮允许处理的部分
- 剩余部分进入下一轮
- 不额外解释“我稍后再回”

这样更像人，而不是公告式排队机器人。

## 7. 发送层抽象

### 7.1 为什么要抽象发送接口

如果回复执行已经成为独立任务系统，那么 worker 不应该直接拼 NapCat 原始 segments 并调用底层 API。

需要新增一个小而稳定的发送抽象：
- 让 worker 只表达“我要回复什么”
- 让发送层负责“怎么发出去”

### 7.2 设计建议

建议新增：
- `src/messaging/message-sender.ts`
- `src/messaging/segment-builder.ts`

建议职责划分：

1. `MessageSender`
- `sendMessage(groupId, content)`
- `replyToMessage(groupId, messageId, content)`
- 统一处理重试与日志

2. `SegmentBuilder`
- 将内部回复内容渲染成 NapCat segments
- 支持 reply / at / text 的组装
- 未来可扩展 forward / card / rich media

### 7.3 与现有代码关系

当前 `qq-bot-v2` 只有 [src/responder/reply-executor.ts](../../../../src/responder/reply-executor.ts) 这一层，过于贴近 NapCat。

可借鉴 `Lynn` 的两点：
- 在 transport 层统一封装发送能力
- 在独立位置处理文本到 segments 的转换

但不建议照搬 `Lynn` 里把发送细节散落到业务编排中的方式。

## 8. 模块改造建议

### 8.1 现有模块保留

继续保留并复用：
- `src/bot/core.ts`
- `src/database/messages.ts`
- `src/responder/context-builder.ts`
- `src/responder/ensure-descriptions.ts`
- `src/agent/loop.ts`
- `src/responder/reply-executor.ts`（作为后续发送抽象的底层实现来源）

### 8.2 新增模块建议

1. `src/conversation/types.ts`
- 定义 mention 事件、群级会话、worker 输入结构。

2. `src/conversation/dispatcher.ts`
- 在消息主链路中检测 `@bot` 后，生成 mention 事件并入队。

3. `src/conversation/group-mailbox.ts`
- 管理单群聚合窗口、待处理事件集合、群内运行状态。

4. `src/conversation/scheduler.ts`
- 管理跨群调度。
- 负责何时把某群窗口封口并交给 worker。

5. `src/conversation/worker.ts`
- 读取当前群这一轮的 mention 事件集合。
- 构造上下文。
- 调用 LLM 或 agent 生成回复。
- 交给 `MessageSender` 发出。

6. `src/messaging/message-sender.ts`
- 发送抽象接口。

7. `src/messaging/segment-builder.ts`
- 回复内容转 NapCat segments。

### 8.3 对 `at-mention` handler 的调整

当前 [src/responder/handlers/at-mention.ts](../../../../src/responder/handlers/at-mention.ts) 在 handler 中直接完成回复。

一期应调整为：
- 检测到 `@bot`
- 只登记 mention 事件
- 返回 `break`

正式回复不再由 handler 自己生成。

## 9. 可扩展性设计

虽然一期只做 `@reply`，但这套结构必须为后续留扩展点。

未来任务源可以增加：
- `proactive_reply`
- `discovery_share`

推荐做法：
- 一期的 `conversation scheduler` 和 `group mailbox` 不绑定 `@reply`
- 只把任务源类型先固定为一个字段
- 后续增加任务源时，复用同一套群级调度能力

这样以后实现：
- 主动浏览论坛
- 主动分享话题
- 主动插话回复

都不需要推翻一期架构。

## 10. 一期验收标准

功能层：
- 收到 `@bot` 时，不再在消息主链路中直接回复。
- `@bot` 会进入独立任务系统。
- 不同群可同时处理回复。
- 同群不会并发生成两轮回复。
- 同群 30 秒内多条 `@` 可被聚合。

行为层：
- 默认尽量一条发完。
- 特殊情况下最多两条。
- 多人同时 `@` 时，不会明显串话。
- 超过处理上限时，可以静默分批。

工程层：
- 内存队列实现与业务逻辑解耦。
- 后续替换 Redis 时，无需重写 dispatcher / scheduler / worker 主逻辑。
- 发送逻辑通过抽象层调用，不让 worker 直接依赖 NapCat 原始细节。

## 11. 非目标与后续演进

一期明确不做：
- ack
- 主动回复
- 主动论坛发现
- 任务持久化表
- Redis
- AI 会话边界判断

建议的后续顺序：

1. 第二阶段
- 将内存队列替换为 Redis 队列
- 增加任务恢复与失败补偿

2. 第三阶段
- 引入群注意力状态
- 在已有群级调度器上支持主动回复

3. 第四阶段
- 引入外部发现任务（论坛/网页）
- 接入统一任务优先级模型

## 12. 最终建议

本次推荐方案不是把同步回复“换个线程跑”，而是建立一个真正独立的会话任务系统。

一期最重要的不是做复杂行为，而是先把边界改对：
- 存储是存储
- 回复是回复
- `@` 是触发事件
- 调度器决定何时处理
- worker 决定如何回答
- sender 负责怎么发出去

这套边界一旦建立，后续扩展主动回复与主动分享时，架构不会再被推翻。
