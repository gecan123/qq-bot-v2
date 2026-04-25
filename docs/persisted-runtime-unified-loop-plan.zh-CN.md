# QQ Bot V2 持久化 Runtime 统一 Loop 方案说明

## 当前落地状态（2026-04-24）

- Phase 1-7 的本阶段目标已由 final runtime proactive convergence 收敛完成。
- 所有群消息先持久化到 `messages`，再以 `RuntimeEvent` 进入 root runtime；`scheduler_tick` / `manual_wake` 也只作为事件入口存在。
- passive `@self` 和 proactive dry-run 共用 `ReplyOpportunity -> ReplyDecisionEngine -> ReplyExecutor`，RootRuntime 已不再按 mention / ambient 分派两个 executor；但普通消息真实 `send_message` 仍未开启。
- runtime-native context assembly 已是默认路径，并保留 `RUNTIME_CONTEXT_FALLBACK=ledger` 作为一阶段临时回退开关。
- proactive candidate 是 non-authoritative artifact/audit，不进入 `ReplyRecord`、上下文、compaction、recovery 或后续评分。

## 1. 这份文档讲什么

这份文档说明的是 `qq-bot-v2` 接下来的新方向：

- 不再只做“被动 @ 触发的一次性回复任务”
- 要把被动 `@` 回复和主动回复统一进一个常驻 root runtime
- 而且这个 runtime 不是临时的，而是要像 `kagami` 一样，具备 **persisted runtime/session shape**

一句话总结：

**`qq-bot-v2` 要从“ledger-first 的一次性任务系统”，演进成“runtime-first，但保留 ledger 透明度和兼容投影”的系统。**

---

## 2. 为什么方案改了

之前有一版更保守的方案，核心思路是：

- 保留 `messages + assistant_turns + conversation_state` 作为唯一 continuity substrate
- root runtime 只做 ephemeral orchestration
- 不在早期引入 persisted runtime/session snapshot

但这版方案的前提后来被明确推翻了。

新的要求是：

- `v2` 也希望像 `kagami` 一样，真正拥有 **persisted runtime/session shape**
- 也就是说，root runtime 不是“每次临时从账本拼出来跑一轮”
- 而是“本身就是可以保存、恢复、继续运行的一等对象”

所以现在的新方案，不再是“学 Kagami 的 loop，但不学它的 persisted runtime”，而是：

**把 `qq-bot-v2` 的执行中心真正迁到 persisted root runtime 上。**

---

## 3. 当前 `qq-bot-v2` 的真实状态

当前系统大致是这样工作的：

1. 收到群消息
2. 持久化到 `messages`
3. 检测是否 `@bot`
4. 如果 `@bot`，enqueue mention event
5. scheduler / mailbox / worker 跑任务
6. 临时组上下文
7. 跑一次 one-shot agent session
8. 发回复

这套模型的特点是：

- 消息账本是持久的
- assistant turn 是持久的
- `conversation_state` 和 compaction 是持久的
- 但 runtime 本身不是持久的

也就是说，现在持久化的是“历史”，不是“活着的会话状态”。

---

## 4. 新方案的核心目标

新方案不是单纯再接一条 proactive 链路，而是把系统改成更像这样：

```ts
while (!stopped) {
  restoreOrContinueRuntime()
  drainIncomingEvents()
  runOneRound()
  persistRuntimeSnapshot()
}
```

这里的关键变化有两个：

1. passive `@` 回复和 proactive dry-run 都进入同一个 root runtime
2. runtime/session shape 本身会被持久化，并参与后续恢复

这就意味着，系统会从：

- “任务驱动”

变成：

- “运行时驱动”

---

## 5. 新方案的四类持久化对象

## 5.1 `messages`

`messages` 继续保留为：

- 唯一 inbound source-of-fact ledger
- replay 输入
- 审计输入
- projection rebuild 输入

它的角色不变，仍然是事实账本。

所以这里不是要废掉 `messages`，而是：

- `messages` 不再单独承担 live continuity 的主重建职责
- 但它仍然是最底层的事实真相源

## 5.2 `assistant_turns`

`assistant_turns` 继续只保留一种语义：

- 真实可发送、可恢复、可重试的 outbound reply ledger

这点现在已经明确锁死：

- proactive dry-run candidate **不能**写进 `assistant_turns`

原因很简单：

- `assistant_turns` 现在不是抽象候选表
- 它是 delivery state machine 的一部分
- startup recovery 会主动处理它

所以如果把 dry-run candidate 混进去，会污染：

- recovery
- send path
- outbound ledger 语义

## 5.3 `conversation_state`

这是这次变化里最容易误解的一点。

`conversation_state` 不会立刻消失，也不会在第一阶段变成无关 cache。

它的新角色是：

- **phase 1-2 的 deterministic compatibility projection**

也就是说：

- runtime/session snapshot 逐步接管 continuity
- 但 `conversation_state` 还会继续提供：
  - `compactedBase`
  - 旧 `buildContext()` 依赖的 per-thread cursor
  - compaction / recovery 的兼容面

只有在新的 runtime-native context assembly 已经证明和旧路径等价之后，`conversation_state` 才能继续降级。

## 5.4 `runtime/session snapshot`

这次迁移里，真正成为新中心的是它。

它会成为新的 **continuity substrate**，负责保存：

- `contextSnapshot`
- `sessionSnapshot`
- `stateStack`
- unread state
- wake/reminder state
- pending runtime work
- proactive candidate state
- cursor 水位
- bounded per-sender continuity substate

也就是说，这里开始真正具备 `kagami` 风格的：

- 运行时可恢复
- 会话状态可恢复
- continuity 不再只靠账本现拼

---

## 6. 新方案不是简单照搬 Kagami

虽然方向更接近 `kagami`，但仍然不是直接复制。

## 6.1 一样的地方

和 `kagami` 一样的核心思想：

- 统一事件流
- 单一 root runtime / root loop
- persisted runtime/session shape
- snapshot-first restore
- passive 和 proactive 共用同一个执行根

## 6.2 不一样的地方

`qq-bot-v2` 仍然保留自己的优势：

- `messages` 明确是唯一 inbound ledger
- `assistant_turns` 明确是 sendable outbound ledger
- `conversation_state` 在过渡期继续做 compatibility projection
- 不是一口气把所有旧账本语义抹掉

所以这次不是：

- 直接把 v2 变成 Kagami

而是：

- 在 `kagami` 的 runtime-first 思路上，保留 v2 的账本透明度和兼容层

更准确地说：

**这是 “Kagami-style persisted runtime” 和 “v2-style deterministic ledger compatibility” 的混合路线。**

---

## 7. 新方案的关键结构

## 7.1 Root Runtime Key

第一阶段的 root runtime key 选的是：

- `qq_group:<groupId>`

原因是当前系统的 group mailbox / scheduler 本来就是 group-scoped。

但这里有个重要补充：

- sender continuity 仍然存在
- 只是它不再直接等于 root runtime key

这就是为什么我们要拆两层 cursor。

## 7.2 双 Cursor 模型

不能再只用一个 `lastProcessedMessageRowId` 了。

必须拆成两层：

### Group Root Cursor

- `lastObservedMessageRowId`

用途：

- group unread catch-up
- runtime ingress replay
- 观察整个群的消息流

### Per-Sender Continuity Cursor

- `lastMaterializedMessageRowId`

用途：

- sender continuity working set
- runtime 内具体 sender 子状态的 materialization 水位

这样才能同时表达：

- 群级消息流
- sender 级 continuity

## 7.3 Bounded Per-Sender Continuity

因为 root runtime 现在是 group-scoped，所以不能把所有 sender 的 working set 永久塞进一个 snapshot blob 里。

必须做 bounded strategy，例如：

- TTL
- cap
- 子记录规范化

更重要的是，这里还加了一条 release gate 级别的不变量：

### Sender Continuity Eviction / Rehydration Invariant

当某个 sender 的 substate 因为 TTL/cap 被淘汰后，系统必须能够仅靠：

- runtime snapshot
- `conversation_state` projection
- `messages`
- sendable `assistant_turns`

重新恢复出：

- 相同的 `lastMaterializedMessageRowId`
- 相同有效 continuity state

这不是“尽量恢复”，而是必须 deterministic rehydrate。

---

## 8. 新的分工：replay / recovery / compaction / context assembly

## 8.1 Replay

仍然是 ledger-based。

输入主要来自：

- `messages`
- `assistant_turns`

但 replay 不再负责“从零拼出整个 live session”，而是：

- 在 restore 之后补 delta

## 8.2 Recovery

会变成：

1. restore runtime snapshot
2. replay inbound delta
3. reconcile `conversation_state` projection
4. recover sendable `assistant_turns`

也就是说：

- 先恢复 runtime
- 再补账本差量

这就是典型的 snapshot-first recovery。

## 8.3 Compaction

不再只是 `conversation_state.compactedBase` 的单点逻辑。

新的分工是：

- runtime snapshot：持有 live continuity
- `conversation_state`：保留 compatibility projection
- compaction：在过渡期继续服务旧路径，但未来会逐步转成 runtime-owned

## 8.4 Context Assembly

现有的 [context-builder.ts](/Users/zzz/WebstormProjects/qq-bot-v2/src/responder/context-builder.ts) 不会一开始就删除。

它会先从：

- continuity owner

降级成：

- projection helper

也就是说，continuity 不再由它定义，而是由 runtime snapshot 定义；它只是把 continuity 投影成一轮 LLM 可消费的输入。

---

## 9. 新旧上下文必须做 Parity Proof

这次计划里最重要的一条执行门槛之一，就是：

当前 `buildContext()` 和新的 runtime-native context assembly 不能只说“差不多”，必须验证：

### Text Equivalence

如果场景应该完全一致，就要求输出逐字一致。

### Prefix Equivalence

如果不能逐字一致，也至少要满足：

- 相同 compacted prefix
- 相同 active-sender materialized suffix 顺序

任何差异都必须文档化。

这条门槛的作用就是防止：

- runtime-first 改造以后，history 虽然“看起来还行”，但实际上 prompt prefix 已经漂移

---

## 10. 主动回复在这个新方案里怎么放

主动回复仍然是 phase 1 dry-run only。

但和之前不同的是，它现在会进入同一个 persisted root runtime。

也就是说：

- proactive evaluator 会进入同一个 root runtime
- 生成的 candidate 会写入：
  - runtime snapshot
  - 独立 audit surface，例如 `proactive_evaluations`

但不会写入：

- `assistant_turns`

也不会进入：

- 真实 send path

这样它有三个好处：

1. 和 passive path 共用同一 runtime continuity
2. 候选可以恢复、审计、观察
3. 不会污染 outbound ledger

---

## 11. 迁移步骤

## Phase 1：先加 Snapshot Schema 和 Restore API

目标：

- 让 root runtime/session snapshot 有地方存
- 能 round-trip
- 能 restore

这个阶段不追求彻底替换旧链路。

## Phase 2：让所有群消息进入 Runtime Ingress

目标：

- 不只是 mention 进入 runtime
- 所有 inbound group message 都进入 runtime ingress

但 passive reply trigger 仍然保留显式 `@self` 规则。

## Phase 3：开始 Dual-Write Continuity + Compatibility Projection

目标：

- runtime snapshot 成为 continuity substrate
- `conversation_state` 变成 deterministic projection

这一阶段会同时维护：

- 新 continuity
- 旧兼容面

## Phase 4：改造 Recovery，并把 Runtime-Native Context Assembly 放到后台做 Parity

目标：

- snapshot-first recovery
- 新旧 context assembly 对拍

这一阶段的关键不是“切换默认路径”，而是先证明新路径对。

## Phase 5：把 Passive Execution Ownership 收回 Root Runtime

目标：

- scheduler / worker 不再是 continuity truth source
- passive 执行 ownership 转到 root runtime

这里还要做 batching / fairness parity 验证，不能只说“看起来没问题”。

## Phase 6：把 Proactive Dry-Run 接进同一个 Root Runtime

目标：

- proactive 进入统一 root runtime
- candidate 可恢复、可审计、不可发送

状态：已由 final convergence phase 完成。candidate 只写 snapshot artifact / `reply_audits` 观测面；失败、空输出、`implicit_text_disallowed` 只写 audit，不写 candidate artifact。

## Phase 7：切换默认 Context Assembly，并逐步退掉旧 Compatibility Path

目标：

- runtime-native context assembly 成为默认
- 旧路径只在 parity proof 完成之后退场

状态：runtime-native context assembly 已成为默认；旧 ledger rebuild 暂时通过 `RUNTIME_CONTEXT_FALLBACK=ledger` 保留一阶段，只允许影响 context assembly，不允许绕过 proactive artifact / recovery / candidate 边界。

---

## 12. 和旧版方案最大的差异

旧版方案强调：

- root runtime 是 ephemeral
- 尽量不早期引入 persisted runtime/session snapshot

新版方案强调：

- runtime/session snapshot 是 continuity substrate
- snapshot-first restore 是正式能力

但新版仍然没有走到“完全 Kagami 化”这么激进。

因为它还保留了：

- `messages` 作为唯一 inbound ledger
- `assistant_turns` 作为纯 sendable outbound ledger
- `conversation_state` 作为 compatibility projection

所以最终形态不是：

- “抛弃 v2，完全变成 Kagami”

而是：

- “在 Kagami 风格 runtime 上，保留 v2 的账本兼容层和透明性”

---

## 13. 一句话总结

这次的新计划不是简单地“把 v2 改得更像 Kagami”，而是：

**让 `qq-bot-v2` 正式进入 persisted runtime/session 时代，同时通过 compatibility projection 保住现有账本体系、恢复路径和上下文稳定性。**
