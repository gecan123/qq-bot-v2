# 永续上下文 Phase 1.5 方案

> 这份文档是落地永续上下文契约的具体方案。它不是新方向，是把 CLAUDE.md 里的 Perpetual Context Contract 真正落到代码层面。

## 0. 背景与定位

### 0.1 当前状态盘点

`docs/runtime-os-roadmap-consensus-draft.zh-CN.md` 描述的 12-phase Runtime OS Roadmap 已经走到 phase 9 边缘：

- ✅ phase 0-4：方向冻结、合同硬化、QQ 群聊迁移、私聊、论坛 read-only 都接进来
- ✅ phase 8：Action Barrier 5 级风险 + 5 种 effectMode 完整
- ✅ phase 9：admin-web 9 个页面（scenes / opportunities / action-records / memory-proposals / self-spine / reading-sessions / llm-traces / groups / playground）
- ⚠️ phase 5-7：表和 review 接口完成，**但没有产生 proposal 的写路径**（memory_proposals / self_spine_update_proposals 是空表，arbiter LLM 选择层接口存在零调用）
- ❌ phase 10-12：未开

### 0.2 P0 缺口

但这条 roadmap 跳过了 CLAUDE.md 写明的 P0：

> Perpetual context here means the LLM history must be stable, replayable, and cheap to extend.
> Core intent:
> - Keep the LLM history prefix as stable as possible across runs.
> - Preserve Claude-style prompt-cache hit rate by avoiding needless rewrites of earlier turns.

实际代码：

- `src/responder/reply-history.ts:8-23` 当前每次 @bot 都现拼一段 `contextText` 字符串塞进 user message，**整段 prefix 每次重建**
- `src/conversation/compaction.ts:122` 当前是 text concat（`[old base, new lines].join('\n')`），不调 LLM，无穷增长
- bot 历史发言通过 `getActionRecordText()` 渲染成 `[BOT] xxx` 文本进 user blob，不是真 `model` role
- KV cache 命中只剩 system prompt 那一段

也就是说："perpetual context"在文档层是口号，在代码层没真做。

### 0.3 本期目标

P0：让 LLM history 真正 append-only，单次 @bot 触发的 prompt 前缀跨调用稳定，让 provider 的 prompt cache 真正命中。

**唯一验证指标**：`LlmTrace.cachedTokens` 列从 `0/null` 变成有数。

## 1. 方案核心思路

把 Kagami 的 `LlmMessage[]` append-only 抽象插进 qq-bot-v2 已有的 `RuntimeEvent → Decision → Barrier → ActionRecord` 流水线。**不替换、只叠加**。

```
NapCat → parser → messages 表 (scene-aware)
              ↓
         RuntimeEvent → Opportunity → Decision → ActionIntent
              ↓                    (idempotencyKey 全程, 不动)
         ActionBarrier (5 级风险, 不动)
              ↓
         effectMode = live | dry_run | suppressed | requires_review | blocked
              ↓
       ┌──────┴──────────────────────────────────────┐
       │  live + actionType=reply 的情况              │
       ↓                          ┌── 本期引入 ─────┐
   AgentContext (单一 AgentMessage[])     真多轮 user/model/tool
   appendMessages(...)                    prefix 稳定
   compactIfNeeded() → LLM summary        计划性重建
       ↓
   tool: send_message → ActionExecutor (不动)
       ↓
   ActionRecord delivery_state (不动)
```

左半段是 qq-bot-v2 的运行时纪律，**完全不动**。中段是本期插入的 append-only history。右半段是 ActionExecutor + audit ledger，**完全不动**。

## 2. 关键决策一览

| 决策项 | 选择 | 理由 |
|---|---|---|
| LLM context 形态 | `AgentMessage[]` 数组，append-only | 唯一能让 prefix 稳定的方式 |
| Bot 历史发言 history role | 真 `model` role | 不再渲染成 `[BOT] xxx` 文本进 user blob |
| Bot 历史发言数据源 | **`action_records`**（保留现状） | live writer 是 ActionExecutor；assistant_turns 当前是死表 |
| Compaction 策略 | LLM summary + 一次性 replace | 取代 text concat |
| Compaction 阈值 | 80 / keep 20（原 40/12） | 让 perpetual append 撑长一点 |
| Summarizer 接口 | 独立 `ConversationSummarizer`，**不动 LlmProvider** | LlmProvider 当前只有媒体方法，扩它影响面太大 |
| 单 RootAgent 心智 | 本期**不做** | 先把 P0 跑通，per-thread 切片暂留 |
| barrier / audit / idempotency / 决策链路 | **完全保留** | qq-bot-v2 真正想清楚的部分 |
| 媒体 15s 预算 + freezeResolvedText | **完全保留** | 同上 |
| admin-web 9 页面 | **完全保留** | 产品级 review surface 沉没价值高 |
| memory_* / self_spine_* 表 | 暂不删，确认死代码身份后 Phase 2 清理 | 不阻塞 P0 |
| AssistantTurn 表 | Step 8 删 | reply-history 不再依赖它后再删 |

## 3. 执行顺序

| # | 文件 | 改动概要 | 验证点 |
|---|---|---|---|
| 1 | `src/responder/context-builder.ts` | `BuildContextResult` 加 `history: AgentMessage[]` + `compactedSummary?: string`；保留 `contextText` 不删；新增 `renderWindowAsMessages(messages, actionRecords)`：群消息→user role；已 `sent`/`acked` 的 action_record→model role；按 anchor 排序 | 现有 test 不破；新字段单独可消费 |
| 2 | `src/responder/reply-history.ts` | 签名换成 `{ windowHistory, compactedSummary, trigger }`；输出 `[summary?, ...windowHistory, trigger]` 真多轮 | typecheck 过 |
| 3 | `src/responder/reply-generator.ts` | 调用 `buildContext` 拿新字段；调 `buildReplyHistory(新签名)` | dev @bot 行为肉眼无差 |
| 4 | `src/agent/context-frame.ts` | `prefixMaterial` = `system + summary 头`；`tailMaterial` = `window + trigger + opportunity` | `LlmTrace.prefixHash` 跨多次 @bot **稳定不变** |
| 5 | **观察期** | 跑 10+ 次 @bot 看 `LlmTrace.cachedTokens` | **从 0/null → 有数 = P0 真完成** |
| 6 | `src/conversation/summarizer.ts`（新）+ `src/conversation/openai-summarizer.ts`（新） | 定义 `ConversationSummarizer` 接口；实现复用 `OpenAIAgentAdapter` 的 chat 能力做单 shot summary | 单测 mock summarizer 能跑通 |
| 7 | `src/conversation/compaction.ts` | 阈值 40→80、12→20；从 text concat 换 LLM summary 路径；`compactedBase` 字段语义升级（schema 不动） | 触发 80+ 消息后 `compactedBase` 是 LLM 摘要；compaction 后 prefixHash 变一次→再次稳定；cachedTokens 仍命中 |
| 8 | 清理 | 删 `BuildContextResult.contextText`、旧 `buildReplyHistory` 签名、context-builder 里 actionRecord→`[BOT]` 文本的渲染段、`AssistantTurn` Prisma model + `assistant-turn-store.ts` + `assistant-turn-delivery.ts` | typecheck + 现有 audit/admin 仍工作 |

## 4. 关键签名变化

```ts
// src/responder/context-builder.ts
export interface BuildContextResult {
  history: AgentMessage[]                   // 新
  compactedSummary?: string                 // 新
  recentMessages: Message[]                 // 保留
  messageCursorStart?: number               // 保留
  messageCursorEnd?: number                 // 保留
  includedActionRecordIds?: string[]        // 保留 (source-ref)
  maxActionAnchor?: number                  // 保留
  compactionSegmentIds?: string[]           // 保留
  // contextText 暂留 → Step 8 删
}

// src/responder/reply-history.ts
export function buildReplyHistory(input: {
  windowHistory: AgentMessage[]
  compactedSummary?: string
  trigger: string
}): AgentMessage[]
// 输出: [summary?, ...windowHistory, { role: 'user', content: trigger }]

// src/conversation/summarizer.ts (新)
export interface ConversationSummarizer {
  summarize(input: {
    previousSummary: string | null
    historyToCompress: AgentMessage[]
  }): Promise<string>
}

// src/agent/context-frame.ts (内部切分调整)
// before: prefix = systemPrompt + initialHistory.slice(0, 1)
// after:  prefix = systemPrompt + (initialHistory 中 [历史摘要] 开头的 user message, 0 或 1 条)
//         tail   = 其余 + opportunity refs
```

## 5. 不动的部分

- `messages` 表 schema（含 `sceneKind` / `sceneExternalId`）
- `media` 表 + `freezeResolvedText` 契约 + 媒体 15s 等待预算
- `Opportunity / Decision / ActionIntent / ActionRecord / ReplyAudit` 全部表
- `ActionExecutor` + `Barrier` + idempotencyKey 全程
- admin-web 9 个页面
- `LlmProvider` 接口（只动 agent adapter 这条）
- `routing-provider` 媒体路由
- `conversationState` 表 schema（`compactedBase` 字段名保留，语义升级）
- `root-runtime` / scene-aware ledger / `RuntimeEventKind`

## 6. 砍的部分（在 Step 8）

- `BuildContextResult.contextText` 字段
- 旧 `buildReplyHistory(contextText, incomingText)` 签名
- `context-builder.ts` 中把 `actionRecord` 渲染成 `[BOT] xxx` 文本的代码段
- `AssistantTurn` Prisma model + 对应迁移 + `assistant-turn-store.ts` + `assistant-turn-delivery.ts`（确认死代码后）

## 7. 暂不处理（Phase 2 候选）

- `memory_proposals` / `memory_items` 死表清理（CLAUDE.md 已明示 out of scope）
- `self_spine_update_proposals` / `self_spine_versions` 死表清理
- `arbiter` LLM 选择层（接口在，无人调）
- `agent_runtime_snapshot` per-group → 单 RootAgent 改造
- per-thread state 切片 → 单条 history（让 cache 跨 sender 共享）
- **`listSentActionRecordsForScene` 全表扫描**（review P2.1）：每次 buildContext 都拉这个 scene 下所有 sent/acked action_records, 内存过滤。bot 跑久后 records 表会膨胀, 跟 "cheap to extend" 目标有冲突。建议改造方向：
  - 浅层修复：reader 加 `createdAtMin` 参数, buildContext 用 `conversationState.updatedAt` 当下界 (best-effort, 不严格)
  - 深层修复：把 `anchor` 从 `resultPayload` JSON 抽出来作为表字段并加索引, 之后用 anchor range 查询
  - 当前不修, 等监控显示 IO 真成瓶颈再做

## 8. 风险与未决项

### 8.1 `getActionRecordText` 文本格式
当前 `getActionRecordText()` 返回的字符串是为"渲染成 `[BOT] xxx` 进文本"准备的，可能含有 segment 序列化痕迹。Step 1 时先 dump 几条真实 `action_record` 看格式，确定能不能直接当 `AgentMessage.content` 用。如果不能直接用，加一个薄 `normalizeActionRecordContent()` 函数。

### 8.2 `AgentMessage.role` 是 `model` 不是 `assistant`
`src/agent/types.ts:24-28` 当前定义：

```ts
export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'model'; content: string }
  | { role: 'tool_calls'; calls: ToolCall[] }
  | { role: 'tool_results'; results: ToolResult[] }
```

要确认 `src/agent/openai-compat.ts` 在序列化时把 `model` 正确映射成 OpenAI `assistant` 角色。不能就先补 mapping 再上 Step 1。

### 8.3 Summary 第一次写入会破坏 prefix 一次
这是 Kagami AGENTS.md 写明的"计划性重建"，预期行为。监控目标是"两次 compaction 之间 cache 命中稳定"，不是"compaction 也命中"。

### 8.4 per-thread state 切片仍存在
当前 `conversationState` 是 `(groupId, senderThreadKey)` 双 key，意味着同一群不同 sender 的 history 不共享。这跟"单条 history"的最终目标不一致。**本期接受现状**，等 P0 验证完成后再决定要不要单 RootAgent 改造。

### 8.5 review 时戳中过的两个错（已修订）
1. ~~assistant_turns 当 history reader 唯一数据源~~ → 改为 `action_records`（assistant_turns 无 live writer，是死表）
2. ~~复用 routing provider 的 contextSummarizer scenario~~ → 改为独立 `ConversationSummarizer` 接口（LlmProvider 没有 chat/summarize 能力）

## 9. Done 标准

| 节点 | 标准 |
|---|---|
| Step 1-4 ship | `pnpm typecheck` 过；`pnpm test` 通过；dev 跑通 @bot；`LlmTrace.prefixHash` 跨多次 @bot 调用稳定不变 |
| Step 5 观察 | 至少 10 次连续 @bot，`LlmTrace.cachedTokens` 列出现非零值 |
| Step 6-7 ship | 触发 80+ 消息后 `conversationState.compactedBase` 是 LLM 摘要（不是 text concat）；compaction 触发后 prefixHash 变一次再稳定；cachedTokens 仍能命中 |
| Step 8 ship | typecheck + admin-web 现有页面正常打开 + `pnpm test` 通过 |

## 10. 时间估计

- Step 1-5（核心 P0）：约 1 周
- Step 6-7（compaction）：约 3 天
- Step 8（清理）：约半天

## 11. 进度记录

> 每步完成后在此追加，用于跨会话延续。

- [x] Step 1: context-builder 输出 history (2026-05-01)
- [x] Step 2: reply-history 新签名 (2026-05-01)
- [x] Step 3: reply-generator 切到新调用 (2026-05-01)
- [x] Step 4: context-frame prefix/tail 切分 (2026-05-01)
- [ ] Step 5: 观察 cachedTokens — **BLOCKED, 等用户回来跑 dev + @bot, 见 `docs/perpetual-context-phase1.5-observation.zh-CN.md`**
- [x] Step 6: ConversationSummarizer 接口与实现 (2026-05-01)
- [x] Step 7: compaction 接 LLM summary (2026-05-01)
- [x] Step 8: 清理 contextText / AssistantTurn writer 等死代码 (2026-05-01)

### 2026-05-01 一次性落地报告

**代码改动:**

新增:
- `src/conversation/summarizer.ts` — ConversationSummarizer 接口 + buildSummarizerHistory + system prompt
- `src/conversation/openai-summarizer.ts` — OpenAI 实现 (复用 agentClient/agentModel, 单 shot chat)
- `src/conversation/summarizer.test.ts` — buildSummarizerHistory 单测
- `docs/perpetual-context-phase1.5-observation.zh-CN.md` — Step 5 观察手册

修改:
- `src/responder/context-builder.ts`:
  - BuildContextResult 字段从 contextText 切到 history + compactedSummary
  - 新增 renderWindowAsMessages (export, 复用给 compaction)
  - 删除旧 renderConversationWindow / actionRecordText / lines 拼装
  - quoted message 作为 user role message 进 history (在 window 之前)
- `src/responder/reply-history.ts`:
  - 旧 (contextText, incomingText) 签名删除
  - 新 ({ windowHistory, compactedSummary, trigger }) 签名作为唯一签名
- `src/responder/reply-generator.ts`: 切到新 buildReplyHistory 调用
- `src/agent/context-frame.ts`:
  - prefixMaterial = system + summary head ([历史摘要] 开头的 user message, 0 或 1 条)
  - tailMaterial = window + trigger + opportunity refs
  - 新增 splitHistoryAtSummary 工具
- `src/conversation/compaction.ts`:
  - 阈值 40→80, 12→20 (生产默认; 测试可注入旧阈值)
  - text concat → LLM summary 路径
  - 新增 ConversationSummarizer 依赖注入字段
  - 没注入 summarizer 时跳过 (不再做 text concat)
  - 新增 renderHistoryToCompress (类似 renderWindowAsMessages 但不限 contextLimit)
- `src/runtime/passive-mention-processor.ts`:
  - compactor 类型从 typeof compactConversationIfNeeded 改成 (groupId, key) => Promise<void>
  - 默认 compactor 注入 createOpenAISummarizer()
- `src/server/playground.ts`: 切到 result.history + result.compactedSummary
- `src/conversation/assistant-turn-store.ts`: 删 writer (createOrReusePendingAssistantTurn / markAssistantTurnSending / Acked / Sent / Failed) + CreateAssistantTurnInput; 保留 reader 给 migration 用
- 各 .test.ts 同步切到新签名/新断言

删除:
- `src/conversation/assistant-turn-delivery.ts` (零 production caller)
- `src/conversation/assistant-turn-delivery.test.ts`

**测试状态:**
- `pnpm typecheck` ✅
- `pnpm test`: 297 pass / 0 fail / 3 skipped (新增 ~10 个 case)

**未 ship 的部分:**
- Step 5 观察期需要真实 dev + @bot 触发, 看 `LlmTrace.cachedTokens` 是否真命中。详细 SQL 和排查 cheatsheet 在 `docs/perpetual-context-phase1.5-observation.zh-CN.md`。
- 如果观察发现 cache 没命中, 排查路径见上述文档第 6 节。

**Review 修复 (2026-05-01 二次落地):**

- **P1.1 Sliding window 修复**: 删 `renderWindowAsMessages` 末尾 `slice(-contextLimit)` 和 `buildContext` 内 `includedMessages` 的同名 slice。lastCompactedMessageRowId 之后的所有消息都进 windowHistory, 真 append-only。这才是 P0 cache 命中的真实保证 (此前 prefixHash 名义稳定但 windowHistory 头部每次新消息都滑动一格)。新增 `Phase 1.5 P1.1` 单测验证 30 条 message + contextLimit=10 时仍全部进 history。**同时解决 P2.2 trace refs 不一致问题** (slice 删了, includedActionRecordIds 跟实际入选 entries 一致)。
- **P1.2 Compaction best-effort 修复**: `passive-mention-processor.ts` 中 post-send compactor 调用包成 `try/catch`, 失败只 log warn 不抛, 不污染已 sent 的 deliveryResult。新增单测验证 compactor throw 时 deliveryResult 仍为 sent。
- **P2.1 listSentActionRecordsForScene 全表扫描**: 不修, 写进上面 "暂不处理" 列表, 等监控显示真成瓶颈再做。

测试状态 (二次落地后): 299 pass / 0 fail / 3 skipped。

**仍未触动 (符合方案):**
- `messages` schema, `media` 契约, `freezeResolvedText`
- `Opportunity / Decision / ActionIntent / ActionRecord / ReplyAudit / Barrier / ActionExecutor` 全部链路
- idempotencyKey 全程
- admin-web 9 页面
- LlmProvider 接口 / routing-provider 媒体路由
- conversationState schema (compactedBase 字段名保留, 语义升级)
- AssistantTurn Prisma model (legacy 迁移路径还在用)
- memory_* / self_spine_* / curiosity 死代码 (Phase 2 候选)
