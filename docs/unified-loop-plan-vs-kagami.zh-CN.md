# QQ Bot V2 统一 Loop 迁移计划与 Kagami 差异说明

## 当前落地状态（2026-04-24）

- 原计划中的统一事件入口、root runtime ownership、proactive dry-run convergence 已由 final convergence phase 落地。
- 当前实现比本文早期设想更接近 persisted runtime：root runtime snapshot 已承担 live continuity，但 `messages` 仍是唯一 inbound user-fact ledger。
- `@self` 和普通消息 proactive dry-run 共享统一 decision/executor surface；RootRuntime 不再拥有单独的 proactive executor 分派；`@self` 是 strong anchored opportunity，普通消息只生成 non-authoritative candidate。
- Scheduler / manual wake 只 emit `RuntimeEvent`，不拥有 generation / send / recovery 语义。
- 真实 ambient `send_message` 仍然不在本阶段开启；未来如果开启，需要单独 gated/canary ADR。

## 1. 这份文档是讲什么的

这份文档回答两个问题：

1. `qq-bot-v2` 接下来准备怎么改，才能把“被动 @ 回复”和“主动回复”统一进一个常驻 loop。
2. 这个方案和 `kagami` 当前实现到底哪里一样，哪里不一样，为什么不能直接照搬。

一句话先说结论：

- 目标方向和 `kagami` 一致：都要走向“统一事件流 + 常驻 runtime + 单一决策中心”。
- 落地方式和 `kagami` 不完全一样：`qq-bot-v2` 必须保住自己现有的 perpetual-context 契约，不能直接把 `kagami` 的 persisted runtime/session 形态搬过来。

---

## 2. 当前 `qq-bot-v2` 是怎么工作的

当前 `qq-bot-v2` 的主链路本质上还是一条“被动回复任务链”：

1. NapCat 收到群消息
2. 解析消息、处理媒体、写入 `messages`
3. 如果消息里有 `@bot`，就 enqueue 一条 mention event
4. scheduler / mailbox 做 merge window 和群级串行
5. worker 按 sender-thread 取上下文
6. 临时启动一次 agent session
7. 生成回复并发送

也就是说：

- 消息存储是常驻的
- 上下文压缩和 assistant turn 是持久的
- 但“思考与回复”本身还是一次性任务，不是常驻 Agent loop

现在 v2 已经有很重要的基础设施：

- `messages`：唯一的 inbound user-fact ledger
- `assistant_turns`：bot 真正发出去的回复历史
- `conversation_state`：压缩前缀和 incorporation cursor
- `compaction`：把旧历史冻结成稳定前缀

这套东西非常关键，因为它已经构成了 v2 的 perpetual context 契约。

---

## 3. 我的目标是什么

我的目标不是“再做一条主动回复链路”，而是把系统改成：

```ts
while (!stopped) {
  drainEventsIntoRuntime()
  runOneRound()
}
```

在这个模型里：

- 被动 `@` 回复和主动回复都只是同一个 runtime 里的不同事件 / 不同决策结果
- `@` 不再是“另一条专用执行链路”
- 主动回复和被动回复共用同一个上下文装配、同一个决策入口、同一个 send barrier

但这不等于一步到位地复制 `kagami`。

---

## 4. 我的迁移计划

## 4.1 Phase 0：先冻结红线

先明确哪些东西绝对不能在迁移里被破坏：

- `messages + assistant_turns + conversation_state` 是唯一 authoritative durable history substrate
- 不能引入第二套 durable truth source
- 主动回复第一阶段只能 dry-run
- proactive artifact 不能进入任何 runtime 决策闭环

这里的核心不是“先写代码”，而是先把真相源边界锁死。

## 4.2 Phase 1：统一事件模型，但不改历史真相

先把 ingress 变成统一事件：

- `group_message_received`
- `mention_cue_detected`
- `proactive_tick`
- 其他后续事件

但是这一步只做一件事：

- 消息仍然先写 `messages`
- 事件只是从已持久化消息事实派生出来

也就是说，event 可以存在于：

- queue
- transient store
- logs

但 event 绝不能成为：

- replay authority
- recovery authority
- compaction authority
- history reconstruction authority

## 4.3 Phase 2：引入 root runtime，但它必须是 ephemeral

这一阶段开始有统一 runtime，但这个 runtime 只是 orchestration layer：

- 负责 event ordering
- 负责单轮串行
- 负责 dedupe boundary
- 负责 send barrier
- 负责“用现有 authoritative ledgers 组装一轮上下文”

它不能做的事：

- 不能把自己的 session/runtime snapshot 变成新的 durable history truth
- 不能参与 replay/recovery/compaction 的 authority

这是和 `kagami` 最大的结构差异之一。

## 4.4 Phase 3：把被动回复 ownership 切给 root runtime

这一阶段不是“删掉 scheduler”，而是：

- scheduler 继续做 merge/timer producer
- 但 scheduler 不再拥有 generation / dedupe / send
- root runtime 成为 passive reply 的唯一 owner

切完之后，必须满足：

- scheduler path 中不存在 generation 调用
- scheduler path 中不存在 dedupe 调用
- scheduler path 中不存在 send 调用

也就是说，scheduler 从“执行中心”退化成“整形 / 生产事件的外围模块”。

状态：已完成。NapCat 持久化后的群消息通过 `RuntimeEvent` 进入 root runtime；scheduler/manual wake 也只作为 runtime event producer。

## 4.5 Phase 4：把主动回复接进同一个 runtime，但只 dry-run

主动回复会进入同一个 root runtime，但是第一阶段只允许产出：

- proactive candidate artifact

这类 artifact 必须：

- 单独存储
- 明确 non-authoritative
- 不能写入 `assistant_turns`
- 不能推进 `lastIncorporatedMessageRowId`
- 不能进入 compaction
- 不能被 `buildContext()` 当成 assistant history
- 不能进入任何 runtime decision-input loop

这里要特别强调最后一条：

`proactive dry-run artifact` 不只是“不会真实发送”，还必须“不会反过来影响后续决策”。

也就是说它不能参与：

- reply selection
- suppression
- fairness
- batching
- ranking
- cooldown
- send gating

除非未来单独开 ADR 明确放开。

状态：已完成。proactive dry-run 只能写 non-authoritative candidate artifact / audit；不会创建 `ReplyRecord`，不会发送，失败输出也不会写 candidate artifact。

## 4.6 Phase 5：收口 bypass path

最后才去清理剩余的一次性分叉：

- 旧的 direct mention shortcut
- 绕过 root runtime 的 one-shot execution path
- 旧 worker 里还残留的执行 ownership

目标状态是：

- 所有 passive / proactive ingress 都进入 root runtime
- runtime 是单一执行中心
- policy 仍然是独立的 policy
- authoritative history 仍然只来自三张旧账本

状态：本阶段已收口到统一 runtime / decision / executor surface，并完成单 `ReplyExecutor.execute(opportunity)` 执行面；真实普通消息 `send_message` 保持为未来 gated/canary phase。

---

## 5. 这个方案和 `kagami` 一样的地方

## 5.1 一样的总方向

两者都认为：

- QQ 群消息不应该只被看作“触发回复任务”
- 更合理的模型是“事件进入统一 runtime，由常驻 Agent 决定是否回应”

## 5.2 一样的执行形态

两者都追求：

- 统一事件入口
- 单一 root runtime / root loop
- `@` 是高优先级 cue，不是独立 runtime 分支
- passive / proactive 共享同一个决策面

## 5.3 一样的产品判断

两者都不是“被 @ 就必须回”：

- `@` 提高优先级
- 是否真正发言仍然是 runtime 的决策结果

---

## 6. 这个方案和 `kagami` 不一样的地方

## 6.1 最大区别：我不会直接照搬 `kagami` 的 persisted runtime/session

`kagami` 当前是可以持久化 runtime snapshot 和 session snapshot 的。

这在 `kagami` 里合理，因为它本来就是“以常驻 Agent 状态为中心”的系统。

但在 `qq-bot-v2` 里，如果现在直接这样做，风险非常大：

- 会出现第二套 durable truth source
- replay / recovery / compaction 的 authority 边界会被打破
- perpetual context 的 deterministic reconstruction 会变脆

所以在我的方案里：

- `kagami` 的“统一 loop 思想”要学
- `kagami` 的“persisted runtime/session shape”当前阶段不能直接搬

## 6.2 `qq-bot-v2` 必须保住历史账本优先，而不是 runtime 状态优先

`qq-bot-v2` 现在的根是：

- `messages`
- `assistant_turns`
- `conversation_state`

这些已经是产品真实运行的 durable substrate。

所以新的 root runtime 只能建立在它们之上，不能反过来取代它们。

换句话说：

- `kagami` 更像“runtime-first”
- 我给 `qq-bot-v2` 的方案是“ledger-first, runtime-over-ledger”

## 6.3 `qq-bot-v2` 还要保留现有群聊产品策略层

`kagami` 的状态机和 runtime 非常干净，但 `qq-bot-v2` 当前已经沉淀了很多群聊产品细节：

- merge window
- group mailbox
- sender fairness
- sender-thread continuity

这些不能粗暴删掉。

所以我的做法不是“立即移除 scheduler”，而是：

- 先把 runtime 变成执行中心
- 再把 scheduler 降成 producer-only

这是典型的 strangler migration，而不是平移。

## 6.4 主动回复第一阶段在我这里更保守

`kagami` 的目标是让 Agent 真正参与生活，可以真实发言。

而 `qq-bot-v2` 这次迁移里，我要求主动回复第一阶段必须：

- 只 dry-run
- 不真实发送
- 不进入历史账本
- 不影响后续决策

这比 `kagami` 当前的主动性设计更保守，但更适合 v2 的迁移阶段。

原因很简单：

- v2 现在的主产品体验还建立在“稳定 @ 回复”上
- 主动回复一旦误发，风险远高于 passive path regression

所以第一阶段必须先观察，不直接放权。

---

## 7. 为什么我不建议“直接做成 Kagami”

因为“方向一样”不等于“结构可以原样复制”。

如果直接把 `qq-bot-v2` 改成 `kagami` 形态，最容易犯的错有三个：

1. 新增 runtime/session 持久化，然后不知不觉把它用进 replay / recovery / compaction
2. 在 scheduler 还没退场时又让 root runtime 拥有半套 generation ownership，形成双中心
3. 把 proactive candidate 混进 `assistant_turns` 或上下文，导致 dry-run artifact 变成软性真相源

我的计划就是专门为了避开这三个坑。

---

## 8. 这份计划最终想得到什么

最终得到的不是“另一个 Kagami”，而是：

- 一个保留 `qq-bot-v2` perpetual-context 契约的统一 runtime
- 一个 passive / proactive 共用的决策中心
- 一个 scheduler 退居外围、runtime 居中的执行模型
- 一个对主动回复非常保守、但结构上已经接对的演进底座

更准确地说，终局是：

- 在理念上接近 `kagami`
- 在历史真相源设计上继续保留 `qq-bot-v2` 自己的优势

---

## 9. 一句话总结

这次迁移不是“把 `qq-bot-v2` 改造成 `kagami`”，而是：

**借 `kagami` 的统一 loop / 单一 runtime 思路，重构 `qq-bot-v2` 的执行中心，同时严格保住 v2 现有的 ledger-first perpetual-context 契约。**
