# Single-Context MVP 设计文档

**Date**: 2026-05-03
**Branch**: single-context-mvp
**Status**: IMPLEMENTED — 待生产观察一周

## 1. 目标

把 qq-bot-v2 从「多 scene + 7 张决策表 + dispatcher」的 per-scene 架构,**全部抹掉**,改成 Kagami-style 的**单上下文 BotLoopAgent**:一个 bot,一份 AgentContext,一个 messages 数组,一份 system prompt,自己通过 wait / send_group_message 决定何时说话何时休息。

**不接 Kagami 包,不 npm link**,所有 runtime 原语在 v2 自己重写。借设计形态,不借代码。

MVP 阶段只服务 1 个测试群,验证 single-context 路线在多源事件下能不能跑通、cache 命中率好不好、bot 主动+被动行为是否自然,作为后续是否扩多群的判断依据。

## 2. 取舍记录 (为什么是 single-context)

最初有三条候选路线:

A. **dispatcher 重构** (per-scene context + 应用层 EventQueue 调度): 已写过完整计划文档,但本质是把现有架构整理一遍,没解决两个根本问题——
   1. 跨 scene 知识流动困难 (要建 inner_journal / RAG 等额外结构)
   2. dispatcher.ts 容易变成新 god class

B. **Kagami-style 单上下文**: 一份 messages 容纳所有事件源 (本群 / 私聊 / 论坛 / RSS / 系统通知),LLM 通过 wait 工具自主节奏。
   - 真正的 "Agent as a life",跨源知识天然连续
   - 但多群同时进会出现「串台」(LLM 在群 A 引用群 B 的内容)
   - 多群下 cache 命中率会变差 (任何一个群的消息都会让整段 prefix 改变)

C. **Self + Tail 混合** (一份长期 self + 每次调用临时拼局部 tail): 理论上最优,但需要把现有 perpetual context 红线契约重写,工程量大,且引入新的"contextual rendering"路径,违反当前 red line 1 的真身契约。

最终选 B 做 MVP 的理由:
1. **Kagami 已经验证了它能跑**,不是空想架构
2. **MVP 单群**——B 路线最大的"串台"风险在单群下不存在
3. **A 路线我们已经讨论过**,确认它解决的是表层问题
4. **C 路线的复杂度不适合 MVP**——先把 B 跑一周看真实数据,再决定要不要往 C 演化

如果 MVP 一周后 cache 命中率 / 主动发质量 / 串台情况都好,就保持 single-context 扩多群。如果串台严重,再考虑 Self + Tail。如果连单群都嫌乱,回到 per-scene。

## 3. 架构 (终态)

```
NapCat WS
   │  (message.group → 过滤 BOT_TARGET_GROUP_ID)
   ▼
src/bot/core.ts          // parseMessage + persistMediaReferences + insertMessage
   │
   ▼
src/media/ensure-message-ready.ts
   │  (等媒体描述,segmentsToPlainText 渲染,freezeResolvedTextIfUnset 一次冻结)
   ▼
onMessageReady(IngestedMessage)
   │
   ▼
EventQueue.enqueue({ type:'napcat_message', renderedText, ... })
   │
   ╔═══════════ BotLoopAgent (src/agent/bot-loop-agent.ts) ═══════════╗
   ║ while(!stopRequested) {                                          ║
   ║   drainEvents()                  // BotEvent → user message       ║
   ║   if (context 空) await waitForEvent(); continue                  ║
   ║   runRound()                     // LLM call + execute toolCalls  ║
   ║   persistSnapshot()              // bot_agent_snapshot 写入       ║
   ║   maybeCompact()                 // token > 12k 时摘要重建        ║
   ║   if (queue 空) await waitForEvent()  // 守 LLM 不空跑            ║
   ║ }                                                                ║
   ╚══════════════════════════════════════════════════════════════════╝
   │
   ├── tool: wait                    → eventQueue.waitForEvent() 阻塞
   ├── tool: send_group_message       → messageSender → NapCat 真发
   ├── tool: db_schema / db_read      → src/database/agent-sql.ts
   └── tool: web_search (可选)        → Tavily
```

## 4. 关键不变量 (CLAUDE.md 红线 5 条)

详见 `CLAUDE.md` 的 「Perpetual Context Contract」段。一句话版本:

1. `BotAgentContext.messages` 是真身,持久 == 运行时
2. `messages` 表是事实账本,不是 LLM 账本
3. bot 通过 `send_group_message` 工具说话,不通过 assistant content
4. compaction 是唯一允许重写 prefix 的路径
5. 同样输入 → 字节稳定输出 (cache 命中数学前提)

## 5. 数据模型 (Prisma)

```
Message            -- 入站事实账本 (NapCat 消息 + 媒体)
Media              -- 媒体二进制 + descriptionRaw
LlmTrace           -- LLM 调用观测 (prefixHash / cachedTokens)
BotAgentSnapshot   -- 单行表 (id=1) 持久化 AgentContext.messages
```

旧的 22 张运行时表全部 drop (见 migration `20260503000000_drop_legacy_runtime_tables_and_add_bot_agent_snapshot`)。

## 6. 文件清单

新增 (Phase 1+2):

```
src/agent/agent-context.ts            single-bot AgentContext
src/agent/agent-context.types.ts      AgentMessage 类型
src/agent/event-queue.ts              InMemoryEventQueue<T>
src/agent/event.ts                    BotEvent
src/agent/render-event.ts             BotEvent → 字节稳定 string
src/agent/llm-client.ts               OpenAI ChatCompletion 翻译
src/agent/bot-system-prompt.ts        启动时一次拼装
src/agent/snapshot-repo.ts            bot_agent_snapshot 持久化
src/agent/compaction.ts               token 阈值压缩
src/agent/bot-loop-agent.ts           主循环
src/agent/replay-missed.ts            启动恢复
src/agent/tool.ts                     Tool / ToolExecutor 接口
src/agent/tools/wait.ts
src/agent/tools/send-group-message.ts
src/agent/tools/db-schema.ts
src/agent/tools/db-read.ts
src/agent/tools/web-search.ts
src/agent/tools/index.ts              buildBotTools 集合装配
src/media/ensure-message-ready.ts     等媒体 + 冻结 resolved_text
src/messaging/napcat-sender.ts        从 responder/ 搬出的底层发送
prisma/migrations/20260503000000_drop_legacy_runtime_tables_and_add_bot_agent_snapshot/
```

删除 (Phase 0):

```
src/runtime/        src/responder/       src/curiosity/
src/world-model/    src/conversation/    src/server/
src/memory/         src/redis/           src/observability/
src/agent/          (旧 per-scene 全部删掉, Phase 1 重写)
apps/admin-web/     pnpm-workspace.yaml
docs/dispatcher-refactor-plan.zh-CN.md  + 多份旧方向文档
```

## 7. 启动 + 恢复

启动顺序:

1. `prisma.$connect()`
2. 装媒体 RoutingProvider + setLlmProvider (媒体描述用)
3. `jobQueue.start()` (媒体描述异步队列)
4. `createLlmClient()` (agent 自己的 LLM 客户端,默认 provider/model)
5. `BotSnapshotRepo.load()` 取出 `bot_agent_snapshot` 单行
   - 有 → `context.restorePersistedSnapshot(persisted.snapshot)`
   - 无 → context 从空启动
6. `replayMissedMessages(persisted?.lastWakeAt)` 把 lastWakeAt 之后落库的目标群消息一次性 enqueue
7. `buildBotTools(...)` + `createToolExecutor(...)` 装配工具
8. `createBotLoopAgent({...})` + `startBot({onMessageReady})` 接 NapCat
9. `agent.start()` — 进入主循环

`lastWakeAt` 在每次 `drainEvents` 真追加 user message 时被更新。压缩 / 重启时同步持久化进 BotAgentSnapshot,这样下次启动有锚点。

## 8. 验证 (build + 测试)

- `pnpm typecheck`: 通过
- `pnpm test`: 119/119 通过
- `pnpm build`: 通过
- `node dist/index.js` 启动: 连库 + LLM 注册 + jobQueue + AgentContext + replay + NapCat 上线 + agent loop 挂在 waitForEvent

DB 迁移已 apply (drop 22 张旧表 + 新建 `bot_agent_snapshot`)。

**验证清单 (端到端)** — 等 .env 设好 BOT_TARGET_GROUP_ID 真上群跑:

```
□ pnpm dev 启动           连库 + NapCat 上线 + agent loop 挂起 (无错)
□ 测试群 @bot              1-3s 回复
□ bot_agent_snapshot       id=1 行 contextSnapshot.messages 增长
□ llm_traces.prefix_hash   同一会话内大段稳定, cached_tokens > 0
□ 重启 bot                 snapshot 恢复, 行为连续
□ 媒体消息                 图片/视频被 LLM 看到 (描述已 inline)
□ wait tool                LLM 真在 call (查 llm_traces 看 toolCalls)
□ ambient (没 @ 时主动发)   bot 在合适时机能自己发, 不只是被 @ 触发
```

## 9. 一周观察清单

跑一周记录:

- **Cache 命中率**: `llm_traces.cached_tokens / input_tokens` 平均值 (单上下文最大优势就在这里,目标 > 0.7)
- **每日 token 成本**: 跟历史 per-scene 时代对比
- **主动发频率 + 质量**: 一天主动发几次,是否有价值还是噪声
- **wait tool 调用频率**: bot 是不是真懂得安静
- **压缩触发频率**: 多久达 12k token 触发一次 compaction
- **编辑 / 越界**: 是否引用错时间 / 错人 / 不存在的事

## 10. 下一步分支

观察报告产出后,根据数据判定:

- **单群跑得舒服** → 加群,接受可能的串台风险,继续 single-context 路线
- **单群勉强但加群预期会乱** → 上 Self + Tail 混合架构 (一份长期 self,每次调用临时拼局部 tail)
- **单群也乱** → 回到 per-scene + dispatcher 路线 (老方案被验证为正确)

## 11. 当前未实现 (技术债)

- `web_search` 子 TaskAgent 隔离: MVP 直接在主 round 里同步调,大概率 token 还行;若 query/result 太大再上 TaskAgent
- 多群: MVP 限定单群,工具 send_group_message 强制限 BOT_TARGET_GROUP_ID
- forum / RSS / 主动反思 idle: 全砍掉,看 single-context 实现下是否还需要再说
- 媒体异步描述就绪 (`media_ready` event): 当前同步等(`REPLY_MEDIA_TIMEOUT_MS`),后续要降延迟时再改异步
- compaction 需要观察:12k 阈值是不是合理,keepRatio 0.1 会不会太狠

## 12. 红线变更说明

CLAUDE.md 的 「Perpetual Context Contract」5 条全部保留 (语义不变),但表述从 per-scene 改成 single-context:

- 红线 1: `scene_agent_contexts.snapshot` → `bot_agent_snapshot.context_snapshot`
- 红线 2: `scene-message-ingestor.ts` → `media/ensure-message-ready.ts` (一次冻结 `resolved_text`)
- 红线 3: assistant content 不再是"发言",通过 `send_group_message` 工具发送;`final_answer` control tool 删除 (不再需要)
- 红线 4: `src/conversation/compaction.ts` → `src/agent/compaction.ts`
- 红线 5: `src/agent/context-frame.ts` 删除,直接看 `llm_traces` 表的 prefixHash/cachedTokens
