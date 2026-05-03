# qq-bot-v2 重定向瘦身：从「事件触发回复任务」到「持续运行 Agent」

## Context（为什么做这次重构）

用户对当前架构的核心诉求收敛到三件事：

1. **NapCat 接消息**
2. **永续上下文 + 不停工作**（读消息 / 回消息 / 刷论坛）
3. **主动发 + 被动回**

当前代码（已落到 Phase 1d）已经有非常稳的地基：
- 三张账本（`messages` + `assistant_turns` + `scene_agent_contexts.snapshot`，注：`conversation_state` 早在 `20260502160000_drop_conversation_states` 已 drop）
- AgentContext + compaction 永续上下文契约
- NapCat + 媒体描述（图/视频/PDF/音频）
- LLM routing + tools + agent loop
- 决策面 7 张表（`runtime_events / opportunities / decisions / action_intents / action_records / agent_runtime_snapshots / scene_agent_contexts`）+ `inner_journal`

但**形态不对**：
- **接收侧**没问题，已经稳定
- **决策/输出侧**散在多处：mention 走 passive-mention-processor → reply-executor；ambient 走 proactive-scheduler；idle 走 IdleThread cron；论坛走 V2EX polling cron。**这些应该统一到一个协调器里**，否则 LLM 调用会彼此撞车，policy / rate-limit 也无法集中
- proactive 在 dry-run 闸门后，模型不能主动发
- 决策面 4 张表（opportunity / decision / action_intent / action_record）每条 action 都要写 4 条记录，写代码很重

目标：把决策/输出侧**统一到一个 dispatcher**，**不新建 repo，不动接收侧，不动永续上下文契约**，但把输出侧执行面瘦身一半 + 开放主动发（白名单灰度）。

## Goals

- **保留**：三账本 / AgentContext / compaction / NapCat 接收侧 / 媒体 / LLM / tools / inner_journal 全部不动
- **新增**：dispatcher（输出侧单点协调器，**EventQueue 驱动**，借 Kagami primitive）；统一 effect ledger（4 表合 1）；capability + policy 两层
- **重构**：proactive-scheduler / passive-mention-processor / reply-executor / idle-thread / arbiter / action-barrier 合并成 dispatcher 的不同 handler
- **开闸**：主动发消息真发（policy 只控频 + 白名单灰度，不再 dry-run 唯一）
- **删除**：`src/redis/` `src/memory/` `src/observability/`（空目录）+ `apps/admin-web/`

## 关键边界：接收 ≠ 决策/输出

**接收侧**（NapCat → 入库）和**决策/输出侧**（LLM 思考 → 发消息 / 读论坛 / 写日记）是两件事，本计划只重构后者。

```
接收侧(几乎不动,只多一行 enqueue):
  NapCat WS → bot/core.ts → insertMessage(messages 表) → eventQueue.enqueue({type: 'qq_message',...})
  forum cron → forum-connector.ts → upsertThread(forum 表) → eventQueue.enqueue({type: 'forum_new_thread',...})

决策/输出侧(单 dispatcher loop, 借 Kagami 的 EventQueue primitive):
  dispatcher 主循环:
    while running:
      events = drainAll(eventQueue)                   // 一次 batch 把所有排队事件取出
      if events.length === 0:
        await eventQueue.waitForEvent()               // 阻塞直到下个事件 (真消息 / forum / wake-timer)
        continue
      for [sceneId, sceneEvents] of groupByScene(events):
        try { await dispatchSceneBatch(sceneId, sceneEvents) }
        catch (err) { log.error(...) }

  心跳 producer(让 idle reflection 有机会触发):
    setInterval(() => eventQueue.enqueue({ type: 'wake' }), 30 * 60 * 1000)
```

### 借 Kagami 的 EventQueue primitive

参考 `kagami/packages/agent-runtime/src/event-queue.ts`,核心三个方法:

```ts
interface EventQueue<T> {
  enqueue(event: T): number       // 非阻塞 push, 唤醒所有 waiter
  dequeue(): T | null             // 非阻塞 pop
  waitForEvent(): Promise<void>   // 阻塞直到队列从空变非空 (不消费事件)
}
```

**关键洞察**:timer 不是独立的「定时器通道」,它就是另一个 producer——`setInterval(() => queue.enqueue({type:'wake'}), N)`。**真消息和 timer wake 在同一队列里,下游分不出谁是谁,也不用分**。

### 设计选择:借 queue 但不给 LLM 加 wait tool

Kagami 把 `wait` tool 给 LLM 是因为它走单 context 多 state 模型——LLM 一直在运行,自己决定何时休息。

我们走 **per-scene context**(永续上下文契约),每个 scene round 跑完就返回——LLM 不需要 wait tool,**dispatcher 自己在事件之间用 `waitForEvent()` 等就行**。

| | @ 回复延迟 | 接收侧改动 | LLM 心智负担 | per-scene context |
|---|---|---|---|---|
| 纯 15s tick | 7-15s | 0 | 无 | 保 |
| Kagami 完整版(带 wait tool) | 1-3s | 1 行 enqueue | 中(LLM 要懂 wait) | 不保 |
| **本方案: 借 queue 不借 wait tool** | **1-3s** | **1 行 enqueue** | **无** | **保 ✓** |

### 设计原则

- **接收侧只多 1 行 enqueue**。bot/core.ts 在 `insertMessage` 之后加 `eventQueue.enqueue(...)`,1 行。forum cron 同理
- **故障重启零数据丢失**。重启后:scene cursor 仍在 `scene_agent_contexts.snapshot`,启动时 dispatcher 通过 cursor 查 DB 把「关机期间漏掉的消息」一次性 enqueue 进队列(replayMissedEvents)。然后正常进入 loop
- **突发消息天然 batch**。drainAll 一次取走全部排队事件,LLM 一轮看到全部上下文
- **没有轮询**。dispatcher 在 events 空时 `waitForEvent()` 阻塞,@ 一来立刻唤醒

### dispatcher 的职责边界

`dispatcher` 是**输出侧的单点协调器**,目的:

- LLM 调用不并发抢资源(同一时刻只一个 scene round 在跑)
- policy / rate-limit / effect-ledger 写入只有一处
- 各种 handler (mention 回复 / ambient 主动发 / forum 阅读 / idle 反思) 共享同一份 AgentContext 加载逻辑
- per-scene 处理:同一 scene 的多个事件 batch 进同一 round,不同 scene 串行

事件源(producer)四个:
- `bot/core.ts` 持久化群消息后 enqueue `qq_message`
- `bot/core.ts` 持久化私聊消息后 enqueue `qq_message`(私聊用同 kind, 由 sceneKind 字段区分)
- forum connector 抓新帖后 enqueue `forum_new_thread`
- 心跳 timer 每 30min enqueue `wake`(给 idle reflection 用)

## 关键约束（红线）

1. **永续上下文前缀字节稳定不能破**。dispatcher 写 `getSnapshot().messages` 时必须保持 deterministic replay；任何"可能让等价重跑产生不同前缀"的设计直接退回。
2. **`maybeCompactConversation` 是唯一可改写历史前缀的路径**。dispatcher 不能在 handler 中间反复改 AgentContext。
3. **LLM 不能直接产生外部副作用**。capability 必须由 dispatcher 在 policy gate 之后调用，对应 `runtime-os-direction.zh-CN.md` 红线 1。
4. **失败发送绝不写 assistant_turn**。`reply-executor.ts` 现有 try/catch 边界要原样保留到 mention handler（仅 `deliveryResult === 'sent'` 才 append + compact）。
5. **idempotency 必须有**。effect_records 的 `idempotencyKey` 来自稳定语义（`sceneId + opportunityType + sourceMessageRowId` 这种），不能依赖模型文本 / 随机 UUID / 当前时间。

---

## 目录蓝图（终态）

```
src/
  bot/              ← 不动 (NapCat ingress)
  database/         ← 不动
  agent/            ← 不动 (AgentContext / loop / tools / build-llm-request)
  conversation/     ← 不动 (compaction)
  llm/              ← 不动
  media/            ← 不动
  messaging/        ← 不动 (低层 sender)
  config/           ← 不动
  utils/            ← 不动
  world-model/      ← 不动 (inner-journal-store)
  queue/ + jobs/    ← 不动 (媒体描述异步队列, 有人在用)
  curiosity/        ← 收编 (forum-connector / read-executor 由 dispatcher 调用)

  dispatcher/       ← 新增 (输出侧单点协调器, EventQueue 驱动)
    event-queue.ts        # 借 Kagami: enqueue / dequeue / waitForEvent
    dispatcher.ts         # while + drainAll + waitForEvent 主体
    handlers/
      mention.ts          # @bot 回复
      ambient.ts          # 主动发
      forum.ts            # 论坛阅读
      idle.ts             # 空闲反思 (由 wake 事件触发)
    scene-registry.ts     # 当前活跃 scene 列表
    replay-missed.ts      # 启动时按 scene cursor 查 DB 把漏掉的消息 enqueue 回队列

  scenes/           ← 新增
    types.ts              # Scene interface
    qq-group.ts           # Mention / ambient
    qq-private.ts
    forum.ts              # V2EX 接进来

  capabilities/     ← 新增
    types.ts              # Capability interface
    send-group-message.ts
    send-private-message.ts
    read-forum-thread.ts

  policy/           ← 新增
    rate-limit.ts         # 替代 action-barrier (轻闸门)

  effect/           ← 新增
    effect-ledger.ts      # 替代 opportunity/decision/intent/record 4 张表

  responder/        ← 削减 (agent-session 留, ensure-descriptions 留, mention 路由删)

DELETE：
  src/redis/  src/memory/  src/observability/   (空目录)
  src/runtime/proactive-scheduler.ts             (Phase 4 替换)
  src/runtime/proactive-send-dispatcher.ts       (Phase 4 替换)
  src/runtime/passive-mention-processor.ts       (Phase 3 替换)
  src/runtime/idle-thread.ts                     (Phase 5 替换)
  src/runtime/arbiter.ts                         (Phase 6 删)
  src/runtime/action-barrier.ts                  (Phase 4 替换)
  src/runtime/reply-decision-engine.ts           (Phase 6 删)
  src/runtime/reply-executor.ts                  (Phase 3 拆解到 dispatcher mention handler, 保留发送/append/compact 段)
  src/runtime/action-executor.ts                 (Phase 4 替换)
  src/runtime/agent-runtime-store.ts             (Phase 6 留 snapshot 部分, 删 4 表 helpers)
  src/runtime/agent-runtime-types.ts             (Phase 6 简化)
  src/runtime/root-runtime.ts                    (Phase 3 替换为 dispatcher wiring)
```

---

## Phase 0 — 静态清理（半天，零风险）

**目标**：先丢掉真正没人用的东西 + 删 admin-web，仓库瘦一圈。

**动作**：
- `git rm -rf src/redis/ src/memory/ src/observability/`（空目录）
- `git rm -rf apps/admin-web/`（用户决定不保留）
- 检查 `pnpm-workspace.yaml` 把 admin-web 引用去掉
- 检查 `src/server/http.ts` / `src/server/` 里有没有专为 admin-web 服务的 API route，能删的删（注：基础健康检查 route 保留）
- 跑 `pnpm build && pnpm test`，确认绿

**验证**：build 通过，所有现有测试绿，bot 启动后 mention 回复仍正常。

**不做**：proactive / curiosity / passive-mention / idle-thread / queue 这些都先**保留**——它们要么还在主链路，要么要等 dispatcher 接管才能下线。

**说明**：admin-web 删了之后，观察 prefixHash / cached_tokens 只能从日志和 DB 直接看。后续如果发现需要可视化再单独建一个轻量观察面，不阻塞本次重构。

---

## Phase 1 — 新决策内核骨架（1-2 天，并行存在不切流）

**目标**：把决策/输出侧的新目录建起来，模块跑得通单元测试，但**不接到主链路**。接收侧完全不动，当前生产路径完全不变。

**动作**：

1. 建 5 个新目录：`dispatcher/ dispatcher/handlers/ scenes/ capabilities/ policy/ effect/`

2. 新文件（先写空骨架 + 类型 + 单元测试）：
   - `dispatcher/event-queue.ts` — 借 Kagami `InMemoryEventQueue<T>` 实现：`enqueue / dequeue / waitForEvent`。直接照搬 `/Users/zzz/WebstormProjects/kagami/packages/agent-runtime/src/event-queue.ts`，~70 行
   - `dispatcher/dispatcher.ts` — 主循环：`while running { events = drainAll(); if empty: await waitForEvent(); else: groupByScene → handler.handle }`；`start()` / `stop()`
   - `dispatcher/handlers/mention.ts` `ambient.ts` `forum.ts` `idle.ts` — 暂时只写空 stub，下个 phase 才填
   - `dispatcher/replay-missed.ts` — 启动时根据 scene cursor 查 DB 增量，把漏掉的 messages / forum 行 enqueue 进队列（保证重启不丢）
   - `scenes/types.ts` — `interface Scene { id; kind; getCursor(); setCursor(c) }`
   - `scenes/qq-group.ts` `qq-private.ts` `forum.ts` — cursor 读写实现
   - `capabilities/types.ts` — `interface Capability { name; execute(intent, ctx); }`
   - `policy/rate-limit.ts` — `check({ sceneId, action }) → { allowed, reason }`
   - `effect/effect-ledger.ts` — `recordIntent(...)` / `recordResult(...)`，依据 idempotencyKey

3. 新 Prisma migration：`effect_records` 表（**新增**，不动旧 4 表）
   ```prisma
   model EffectRecord {
     id              String   @id @default(cuid())
     sceneId         String
     opportunityType String   // 'reply_to_mention' | 'ambient_send' | 'read_forum_thread' | 'idle_reflect' | ...
     actionType      String   // 'send_group_message' | 'send_private_message' | 'read_forum_thread' | 'noop'
     status          String   // 'proposed' | 'allowed' | 'rejected' | 'executing' | 'succeeded' | 'failed'
     dryRun          Boolean  @default(false)
     idempotencyKey  String   @unique
     sourceRefs      Json     // { messageRowId?, messageId?, runtimeEventId?, ... }
     decisionPayload Json?    // policy verdict + reason
     resultPayload   Json?    // 执行结果
     decidedAt       DateTime?
     executedAt      DateTime?
     createdAt       DateTime @default(now())
     updatedAt       DateTime @updatedAt
     @@index([sceneId, createdAt(sort: Desc)])
   }
   ```

4. 跑 `pnpm db:migrate`，新表创建。

**验证**：所有新文件单元测试绿；现有主链路完全不动；mention 回复正常；bot 不重启即可继续工作。

---

## Phase 2 — dispatcher 启动 shadow 模式（事件源接通, 不切流）

**目标**：bot/core.ts 加上 enqueue 钩子，dispatcher 收到事件但**只观察不动作**——旧 root-runtime 链路继续完整工作。

**动作**：

1. 修改 `src/bot/core.ts`：在 `insertMessage` 之后**额外**调一行 `eventQueue.enqueue({ type: 'qq_message', sceneKind, sceneExternalId, messageRowId, mentioned })`。两条路径并行（旧 root-runtime + 新 dispatcher 都收到）。

2. 修改 forum-connector：抓到新帖 upsertThread 之后**额外**调一行 `eventQueue.enqueue({ type: 'forum_new_thread', threadId, ... })`。

3. dispatcher shadow 模式：
   - 启动时跑 `replay-missed`，根据 shadow cursor 把漏掉的事件补 enqueue 一遍
   - `dispatcher.ts` 跑起来，drain → handle → wait 循环
   - handler 暂时只 log + 写 effect_records（`status='observed', dryRun=true`）+ 推进 shadow cursor
   - **不调 LLM、不发消息**

4. **重要**：shadow 模式下 dispatcher 用的 cursor **不是** `scene_agent_contexts.snapshot.lastObservedMessageRowId`（那是给旧 root-runtime 用的，不能动），而是新建一张极简的 `scene_dispatcher_cursors` 表，shadow phase 结束后这张表就废弃。

5. 心跳 producer：`setInterval(() => eventQueue.enqueue({ type: 'wake' }), 30 * 60 * 1000)`。

6. 在 index.ts wire：
   ```ts
   const eventQueue = createEventQueue()
   const dispatcher = createDispatcher({ eventQueue, scenes, handlers })
   await replayMissed(eventQueue, scenes)
   dispatcher.start()
   startWakeTimer(eventQueue, 30 * 60 * 1000)
   // 旧 wiring 全部保留:
   // rootRuntime / passiveMentionProcessor / replyExecutor / proactiveScheduler / idleThread / v2exForumPolling
   ```

**验证**：
- 跑 1 小时，`effect_records` 表里有 `status='observed'` 的记录，覆盖期间所有 NapCat 消息
- shadow cursor 跟 `messages.id` 同步推进
- 重启 bot 后 replay-missed 把关机期间的消息补回，cursor 对齐
- @ 一来 dispatcher **立即** observed（看日志时间戳），不是 N 秒后
- 现有 mention 回复行为完全不变（旧 path 还在）
- 进程平稳，无内存泄漏

**意义**：确认 dispatcher 能用 EventQueue 实时接事件 + Postgres effect_records 写入正常 + 重启 replay 工作。下一步开始切被动回复到 dispatcher。

---

## Phase 3 — 切被动回复到 dispatcher（关键里程碑）

**目标**：把 mention 回复从旧 `passive-mention-processor → reply-executor` 路径**完全切到** `dispatcher/handlers/mention.ts`。这一步做完，bot 的 @ 回复行为不变，但执行路径换了底盘。

**动作**：

1. 实现 `dispatcher/handlers/mention.ts`：
   ```ts
   // mention.ts — 由 tick 在 sceneEvents 含 mention 时调用
   export async function handleMentionRound(scene: QqGroupScene, events: SceneEvent[]) {
     const mentionEvent = events.find(e => e.mentioned)
     if (!mentionEvent) return
     const ctx = await loadSceneAgentContext(scene.id)             // 现有函数复用
     const reply = await runAgentSession({ context: ctx, ... })    // 现有 src/responder/agent-session.ts 复用!
     const policyResult = rateLimit.check({ sceneId: scene.id, action: 'send_group_message' })
     if (!policyResult.allowed) { await effectLedger.recordRejected(...); return }
     const sendResult = await sendGroupMessage.execute({
       groupId: mentionEvent.groupId,
       text: reply,
       replyTo: mentionEvent.messageId,
     })
     await effectLedger.recordResult({ ..., status: sendResult.delivered ? 'succeeded' : 'failed' })
     if (sendResult.delivered) {
       ctx.appendAssistantTurn({ role: 'model', content: reply })  // 复用现有 AgentContext
       await maybeCompactConversation(ctx)                          // 复用现有 compaction
     }
   }
   ```

2. **关键复用**（不重写，引用现有模块）：
   - `src/agent/scene-agent-context-store.ts`：`loadSceneAgentContext`
   - `src/responder/agent-session.ts`：`runAgentSession`
   - `src/conversation/compaction.ts`：`maybeCompactConversation`
   - `src/messaging/message-sender.ts`：底层发送实现，capability 包一层

3. 写 `capabilities/send-group-message.ts`：包 `messageSender.replyToMessage`，按 idempotencyKey 写 effect_record。

4. **dispatcher 升级**：tick 里发现 sceneEvents 含 mention 时，调用 `handleMentionRound` 替代 shadow log。dispatcher 的 cursor 推进改成用 `scene_agent_contexts.snapshot.lastObservedMessageRowId`（接管旧 root-runtime 的 cursor 角色），shadow cursor 表删除。

5. **`src/bot/core.ts` 完全不动**——本 phase 接收侧仍零改动。所有切换都发生在 dispatcher 这一侧（dispatcher 接管 cursor + handler）。

6. index.ts：删除 `passiveMentionProcessor` / `replyExecutor` / `actionExecutor` / `replyDecisionEngine` 的实例化，删除 root-runtime 的 mention 分派代码（root-runtime 完整删除，因为 dispatcher 已经接管 scene cursor + decision 全套）。

7. 物理删除：
   - `src/runtime/passive-mention-processor.ts` (+ test)
   - `src/runtime/reply-executor.ts` (+ test)
   - `src/runtime/action-executor.ts` (+ test)
   - `src/runtime/reply-decision-engine.ts` (+ test)

**验证**（必须跑）：
- 真实在 QQ 群里 @bot，确认正常回复，**延迟应在 1-3s（一个 LLM round 时间），与旧路径相当**
- 看 `effect_records` 表：每次 @ 都有一条 `status='succeeded'` 记录
- 看 `assistant_turns` / `scene_agent_contexts.snapshot`：append 正常，前缀稳定（用 `psql` 直接查 `prefixHash` 列，admin-web 已在 Phase 0 删）
- 突发场景测试：连续发 3 条快消息其中 1 条 @bot —— 由于 drainAll 一次取走，应该在同一 round 看到 3 条上下文，bot 回复体现对全部消息的理解
- 跑 `pnpm test` 全绿（旧测试可能要删除，dispatcher / handler 测试要补）

**风险**：这是最大一刀。建议在分支上跑通 + 在生产小群灰度后再合并。**用户体验上 @ 回复延迟与旧路径相当（都是 1-3s）**，所以无需提前知会群友。

---

## Phase 4 — 主动发（白名单灰度）+ 论坛接进 dispatcher

**目标**：proactive 闸**只对白名单 group 开**；其他 group 仍 dry-run。V2EX 论坛从「digest 注入 prompt」升级成「真 scene + 真 capability」；删 proactive-scheduler 和 v2ex-polling 旧 cron。

**动作**：

1. `policy/rate-limit.ts` 实现两层闸门：
   - **第一层（白名单）**：从 env 读 `PROACTIVE_LIVE_GROUP_IDS`（逗号分隔）。不在白名单的 group → `dryRun: true`，写 effect_record (status='allowed', dryRun=true) 但不调 capability。
   - **第二层（控频）**：白名单内 group 按 sceneId 维度限流：每 N 分钟最多 M 条主动发；mention 回复另算。
   - mention 回复不受白名单限制，所有 group 都真发（保持现有行为）。

2. `capabilities/send-group-message.ts` 增加非 reply 模式（不带 replyTo）。capability 内不判 dryRun——dryRun 已经在 policy 层被拦下了，capability 收到的就是「真发」。

3. 实现 `dispatcher/handlers/ambient.ts`：
   - 触发：dispatchSceneBatch 处理 sceneEvents 时，**没有 mention 但有新消息**的场景进 ambient handler
   - 内部判断：距上次发言 > 冷却时间 + scene 处于 active 窗口 + rate-limit 允许
   - LLM 跑一轮 ambient prompt（系统提示里说「你可以选择不发言」），输出 `{ action: 'noop' | 'send', text? }`
   - policy gate → capability execute → effect_record + AgentContext append（仅 sent 时）
   - 注意：突发 5 条普通消息时 drainAll 一次拿到，ambient handler 看到的就是这 5 条 batch，**这就是「像活人」的来源**

4. 论坛接入：
   - 复用 `src/curiosity/forum-connector.ts` + `v2ex-connector.ts` 抓取逻辑（继续按现有节奏跑 cron 抓帖子写表）
   - 删掉 proactive digest buffer 的写入，新帖子写 forum 表后立即 `eventQueue.enqueue({type: 'forum_new_thread', ...})`
   - 实现 `dispatcher/handlers/forum.ts`：LLM 决定 `read_forum_thread` 或 `noop`
   - `capabilities/read-forum-thread.ts`：调 `forum-read-executor.ts` 现有逻辑，标记已读 + 把帖子内容 append 到 forum scene 的 AgentContext（这是 forum scene 自己的 context，与 QQ scene 独立）

5. 物理删除：
   - `src/runtime/proactive-scheduler.ts`
   - `src/runtime/proactive-send-dispatcher.ts`
   - `src/runtime/action-barrier.ts` (+ test)
   - `src/runtime/arbiter.ts` (+ test)
   - index.ts 里的 `startProactiveScheduler` / `startV2exForumPolling` 调用
   - `proactiveDigestBuffer` 相关代码

**验证**：
- 主动发（白名单内）：在 `PROACTIVE_LIVE_GROUP_IDS` 列出的群里 bot 能在没被 @ 的情况下发言
- 主动发（白名单外）：其他群只在 effect_records 看到 `status='allowed', dryRun=true` 的记录，没有真实发送
- 论坛：日志能看到 forum scene 的 AgentContext 里出现帖子内容；bot 真去读了某些帖子（看 `forum_read_state` 表 + `effect_records`）
- rate limit 生效：白名单群里连续触发 ambient 应该被 policy 拒（effect_records 里的 rejected 记录）
- mention 回复在所有群仍然正常工作

---

## Phase 5 — 空闲反思接进 dispatcher

**目标**：把 IdleThread cron 改造成 dispatcher 的 idle handler；保留 inner_journal 写入路径不变；保留 reactive @ 注入 ephemeralSuffix 路径不变（Phase 1d 行为完整保留）。

**动作**：

1. wake-timer 在 Phase 2 已经在跑（`setInterval(() => eventQueue.enqueue({type: 'wake'}), 30 * 60 * 1000)`），idle 由 wake 事件触发即可。

2. 实现 `dispatcher/handlers/idle.ts`：
   - 触发：dispatcher 收到 `{type: 'wake'}` 事件时，遍历 activeScenes
   - 每个 scene 检查触发条件：距上次 LLM 调用 > 30min + scene 在最近 N 小时有事件
   - 满足条件的 scene 跑一轮反思 prompt（复用现有 `prompts/idle-reflection.md`）
   - 结果写 `inner_journal`（复用现有 `src/world-model/inner-journal-store.ts`）
   - **不写 AgentContext**（保持 Phase 1d 设计——前缀稳定）

3. reactive @ 注入路径（Phase 1d 已实现）原样保留：mention 触发 reply 时，从 inner_journal 拉最近 1h 条目，作为 ephemeralSuffix 拼到 buildLlmRequest。这段代码在 `src/agent/build-llm-request.ts`，**不动**。

4. 物理删除：
   - `src/runtime/idle-thread.ts` (+ test)
   - index.ts 的 `startIdleThread` 调用

**验证**：
- 让 bot 闲置 35 分钟以上，看 `inner_journal` 表有新条目
- 之后 @ bot，看回复里能体现反思（ephemeralSuffix 注入有效）
- prefixHash 不抖（用 `psql` 查 `llm_traces.prefix_hash` 是否稳定）

---

## Phase 6 — 收尾：彻底 drop 旧表 + 简化 store

**目标**：把已经被 effect-ledger 替代的 4 张旧表 + runtime_events 合计 5 张表 drop 掉；把 `agent-runtime-store.ts` 收缩到只剩 snapshot 部分。**用户已选「彻底 drop 」**。

**动作**：

1. Prisma migration（一次性 drop 5 张表）：
   ```sql
   DROP TABLE IF EXISTS "action_records";
   DROP TABLE IF EXISTS "action_intents";
   DROP TABLE IF EXISTS "decisions";
   DROP TABLE IF EXISTS "opportunities";
   DROP TABLE IF EXISTS "runtime_events";
   ```
   `runtime_events` 也合并到 effect_records——effect_records 的 `sourceRefs` Json 字段已含 `messageRowId / messageId`，可以替代 runtime_events 的事件 audit 角色。

2. `src/runtime/agent-runtime-store.ts`：删除 `createOrReuseOpportunity` / `createOrReuseDecision` / `createOrReuseActionIntent` / `createOrReuseActionRecord` / `createOrReuseRuntimeEvent` / `listPendingArbiterOpportunities` / `markOpportunityStatus`。保留 `getOrCreateMainAgentRuntime` / `getOrCreateScene` / `upsertAgentRuntimeSnapshot` / `getAgentRuntimeSnapshot`。改名为 `agent-snapshot-store.ts` + `scene-store.ts` 两个文件，按职责分。

3. `src/runtime/agent-runtime-types.ts`：删除 `Opportunity` / `Decision` / `ActionIntent` / `ActionRecord` / `RuntimeEvent` 类型，保留 `SceneId` / `MAIN_AGENT_ID` / `makeQqGroupSceneId` / `makeQqPrivateSceneId` / `ActionType`。

4. 物理删除：
   - `src/runtime/root-runtime.ts`（已经被 dispatcher 替代）
   - `src/responder/` 里跟 mention 路由相关的旧文件（保留 `agent-session.ts` + `ensure-descriptions.ts`）

5. admin-web 已在 Phase 0 删除，本阶段不需处理。

**验证**：
- `pnpm db:migrate` 成功（5 张表已 drop）
- `pnpm build && pnpm test` 全绿
- bot 端到端：mention / ambient / forum / idle 四种 round 全部正常
- `psql ... -c "\dt"` 看 schema 不再有 opportunities / decisions / action_intents / action_records / runtime_events
- `effect_records` 表持续被写入

---

## 关键复用清单（不重写的现有模块）

| 现有模块 | 用在哪 | 不动的原因 |
|---|---|---|
| `src/bot/napcat.ts` `core.ts` `message-parser.ts` | NapCat ingress | 稳定，重写无收益 |
| `src/database/messages.ts` `search.ts` | 旧账本 + agent tools | 永续上下文契约根 |
| `src/agent/agent-context.ts` `scene-agent-context-store.ts` `scene-message-ingestor.ts` | AgentContext + perpetual context | **红线**，重写就破契约 |
| `src/agent/loop.ts` `tools.ts` `build-llm-request.ts` | runAgentLoop + tool 工厂 | 已经是新内核要的样子 |
| `src/conversation/compaction.ts` | 唯一前缀 mutator | 红线 |
| `src/responder/agent-session.ts` | runAgentSession + buildSystemPrompt | 已经是 LLM 入口的正确抽象 |
| `src/responder/ensure-descriptions.ts` | 媒体描述等待 | 与 jobQueue 配合，新 loop 直接调 |
| `src/messaging/message-sender.ts` | 底层 NapCat 发送 | capability 包一层即可 |
| `src/llm/*` | provider routing | 不动 |
| `src/media/*` | 图/视频/PDF/音频描述 | 不动 |
| `src/world-model/inner-journal-store.ts` | inner_journal 写读 | 不动 |
| `src/curiosity/forum-connector.ts` `v2ex-connector.ts` `forum-read-executor.ts` `forum-read-store.ts` | 论坛抓取 + 读状态 | 移到 scenes/forum.ts 时引用，不重写 |
| `src/queue/*` `src/jobs/*` | 媒体描述异步 | 不动 |
| `src/config/*` | env 校验 + agent-profiles + prompt-loader | 不动 |

---

## 节奏建议

每个 Phase 自己一个 PR，自己一次本地灰度。次序不能跳：

```
Phase 0 (清空目录 + 删 admin-web)   ──→ 半天
Phase 1 (新决策内核骨架)            ──→ 1-2 天
Phase 2 (dispatcher shadow + 接事件) ──→ 半天
Phase 3 (切被动回复, 删 4 文件)     ──→ 1-2 天 + 灰度  ← 最关键的一刀
Phase 4 (主动 + 论坛, 删 4 文件)    ──→ 1-2 天 + 灰度
Phase 5 (空闲反思, 删 1 文件)       ──→ 半天
Phase 6 (拆旧表 + 简化 store)       ──→ 1 天
─────────────────────────────────────
合计:                            ~7-10 个工作日
```

---

## 端到端验证清单（任意 Phase 结束后必须全绿）

```
□ pnpm build           成功
□ pnpm test            全绿
□ pnpm db:migrate      无 pending
□ bot 启动             无 panic, 日志正常
□ NapCat 收 @bot 消息  正常回复
□ assistant_turns      有新行
□ scene_agent_contexts updated_at 更新
□ llm_traces.prefix_hash  在同一 scene 内稳定, cached_tokens 比例>0 (用 psql 直接查, admin-web 已 Phase 0 删)
```

Phase 4 后追加：

```
□ 主动发消息           bot 在不被 @ 时能正常发言
□ rate-limit          连续触发被 policy 拒, effect_records 有 rejected
□ forum scene         bot 能读论坛新帖, forum_read_state 有更新
```

Phase 5 后追加：

```
□ idle reflection     闲置 35min+ 后 inner_journal 有新行
□ reactive 注入       @ 时 ephemeralSuffix 有内容
```

Phase 6 后追加：

```
□ 旧 4 表已 drop
□ agent-runtime-store.ts 缩到 < 100 行
□ src/runtime/ 目录只剩 snapshot 相关
```

---

## 已确认的关键决策

| 决策 | 选择 | 体现在哪 |
|---|---|---|
| 主动发消息是否真开 | **白名单灰度** | Phase 4 的 policy 双层闸门（白名单 + rate-limit） |
| Schema 迁移做到哪一档 | **彻底 drop 5 张旧表** | Phase 6 一次性 migration |
| admin-web 怎么处理 | **直接删** | Phase 0 即 git rm |
| 论坛 scene 的 AgentContext | **独立 per-scene context**（默认） | Phase 4 forum scene 自己一份 AgentContext，与 QQ scene 完全隔离，符合 perpetual-context 契约 |
