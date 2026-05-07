# Current State

本文件描述 qq-bot-v2 的**当前**实现状态：阶段、文件布局、env vars、当前默认值、最近取舍。这些信息随代码演化变动，**不**写进 CLAUDE.md。修改默认值 / 加减模块 / 调整启动顺序时，更新这里，**不要**改 CLAUDE.md。

CLAUDE.md 只承载长期合约（perpetual context invariants、提交规范、experimental policy 等），跨阶段稳定。

---

## 当前阶段

**MVP-2**：服务 N 个白名单群（`BOT_TARGET_GROUP_IDS`）+ 任意 QQ 好友的私聊（无白名单，仅 ingress 层按 `sub_type='friend'` 过滤陌生临时会话）。`BOT_TARGET_GROUP_IDS` 可空（私聊永远在线）。

**叠加: Idle-Fetch MVP** — `wait` 工具 idle 引信 + `fetch_reddit` / `fetch_url` 工具 + NDJSON 旁路日志。设计文档 `docs/idle-fetch-mvp.zh-CN.md`，14 天复盘模板 `docs/reddit-mvp-review.md`。

**叠加: Claude Code identity 透传 cliproxy (可选启用)** — `LLM_DEFAULT_PROVIDER=claude-code` 时, agent 路径 (BotLoopAgent + compaction + fetch_url 摘要) 走 cliproxy + 完整 Claude Code identity payload (`claude-cli/2.1.76 (external, sdk-cli)` UA + `Anthropic-Beta: claude-code-20250219,...` + 3-block system: billing header / SDK self-id / 业务 persona)。cliproxy `cloak.mode=auto` 识别为 Claude Code 客户端 → **不**替换 system prompt, 直接转发到 Anthropic, 同时复用 cliproxy 自家 OAuth 池 (Claude Pro / ChatGPT Plus 等 5 账号轮换 + quota fallback)。Media 描述路径 (`generate-description.ts` + `RoutingProvider` + `OpenAIProvider`) 不变, 仍走 cliproxy 的 OpenAI 兼容路径。

实测背书 (2026-05-08):
- **P1 不 cloak**: 发完整 Claude Code identity 时 cliproxy 透传, persona spoof 站住 (问"你是谁" → "喵～我是猫猫呀")
- **P2 字节稳定**: `cache_control:{type:'ephemeral',ttl:'1h'}` 挂在**最后一块 system block** (per-block, 不放顶层) 触发真 cache 写。1773 字符 persona 双发实测: 第 1 发 `cache_creation_input_tokens=2287`, `ephemeral_1h_input_tokens=2287` (确认进 1h pool); 第 2 发 `cache_read_input_tokens=2287` 完全命中。CLAUDE.md 红线 5 (字节稳定) 成立。
  - **必须 per-block, 不能放顶层**: cliproxy 6.10.x `internal/runtime/executor/claude_executor.go` 的 `ensureCacheControl` 在 `countCacheControls(body)==0` 时会自动给最后一块 system block 注入 5m, 而 `countCacheControls` 只数 system/tools/messages 里 per-block 的 cache_control, 不数顶层。顶层 1h + cliproxy 注入 5m 同时存在时 Anthropic 在 `prompt-caching-scope-2026-01-05` beta 下报 "ttl='1h' must not come after ttl='5m'" 拒收。挂在 system 最后一块就让 cliproxy 跳过注入, 形态也跟当前真 Claude Code (anthropics/claude-code#49139) 对齐。kagami 因为自家 OAuth 直连 Anthropic 不经 cliproxy, 顶层 cache_control 在它那 work, 但 qq-bot-v2 走 cliproxy 必须 per-block。
- **P3 5 账号池可用**: cliproxy 已配 Claude Pro `claude-gecanzzz@outlook.com.json` + ChatGPT Plus/Pro/Team 三份 + Gemini Code Assist, `/v1/messages` 走 OAuth 池而非 token 计费

URL/API key 复用 `LLM_PROVIDER_CLAUDE_*` (不再需要单独的 `LLM_PROVIDER_CLAUDE_CODE_*` 或 `LLM_CLAUDE_CODE_AUTH_FILE`)。启动期发一条 persona-spoof 自检请求, 回答必须以"喵"开头, 否则 fail-fast 让人查 cliproxy 版本 (P4 风险 mitigation)。
- 主路径代码: `src/agent/claude-code/*` (headers / request / sse-parser / llm-client) — 3-block system 拼装与 wire format **不**改, 这是 cliproxy mode=auto 不 cloak 的前提
- 切换/回滚: 切 `LLM_DEFAULT_PROVIDER` env 即可。其它 provider 分支 (OpenAI 适配器) 保持 byte-identical, cache 回滚不会被触发
- 删除的旧物: 自家 OAuth 直连路径 (`src/auth/claude-code/*` ~700 行) + `scripts/login-claude.ts` + `~/.qq-bot-v2/auth/claude-code.json` 凭据文件 + `pnpm login:claude` script (实证 cliproxy 共享 cache 后失去存在理由)

背景设计文档：`docs/single-context-mvp.zh-CN.md` 和 `~/.gstack/projects/gecan123-qq-bot-v2/zzz-single-context-mvp-design-20260504-010859.md`。本次切换的实证 + 决策记录: `~/.gstack/projects/gecan123-qq-bot-v2/zzz-main-design-20260508-012341.md`。

---

## 短期目标 / Checkpoints

idle-fetch MVP 跑起来后的近期 TODO，做完即勾。过期 / 已收敛的 checkpoint 直接删，不归档。

- [ ] 部署生效：填 `BOT_IDLE_HINT_MS` 实际值（默认 30min，先按默认跑），观察头几天 idle 触发节奏
- [ ] 14 天复盘日期：开始跑当天填到 `docs/reddit-mvp-review.md` 的 "开始跑的日期" + "复盘日期"（开始 + 14 天）
- [ ] **2026-05-18 左右**（= 2026-05-04 + 14d）打开 `docs/reddit-mvp-review.md`，跑里面 4 个 jq 命令把数填进去，按决策清单选 A–G
- [ ] 期间观察的可调旋钮（不破架构）：
  - `BOT_IDLE_HINT_MS`：太频繁 → 调到 1–3 小时；太静 → 调到 15min
  - `COMPACTION_TRIGGER_TOKENS`：fetch 把 compaction 拉得太快 → 临时上调到 24–32k
  - system prompt `[空闲行为]` 段：bot 选品味跑偏时收紧措辞（注意改 prompt = 整段 cache 失效，集中改不要小步频改）
- [ ] 复盘后该删的删（移到 `docs/archive/` 或直接删占位文档），把决策落地到 env / system prompt / 新工具

---

## Required Environment Variables

详见 `.env.example`。启动时全部必填：

- `DATABASE_URL` — PostgreSQL 连接串
- `NAPCAT_WS_URL` — NapCat WebSocket endpoint
- `NAPCAT_ACCESS_TOKEN` — NapCat auth token
- `BOT_TARGET_GROUP_IDS` — 群白名单（逗号分隔，例：`111,222`，可空 = 不监听任何群，纯私聊模式）
- `SELF_NUMBER` — bot 自身 QQ 号（过滤自身消息）

私聊不走 env 白名单：任意 QQ 好友都可以直接给 bot 发私聊，由 `napcat.on('message.private')` 处用 `sub_type === 'friend'` 过滤陌生临时会话。

可选：

- `TAVILY_API_KEY` — Tavily web search，设置则 `web_search` 工具自动注册
- `COMPACTION_TRIGGER_TOKENS` — compaction 触发阈值（默认 16000，多源场景默认值）
- `BOT_IDLE_HINT_MS` — wait 工具空闲提示阈值（默认 1800000 = 30min）
- `BOT_FETCH_REDDIT_TIMEOUT_MS` — fetch_reddit 单次 HTTP 超时（默认 8000）
- `BOT_FETCH_URL_TIMEOUT_MS` — fetch_url 单次 HTTP 超时（默认 12000）
- `BOT_FETCH_LOG_PATH` — NDJSON 旁路日志路径（默认 `logs/fetch.ndjson`）
- `BOT_GROUP_AMBIENT_DRY_RUN` — 主动发言（group-ambient，没有 `replyToMessageId` 的群发送）dry-run 开关。`true` 时 `send_message` 不走 NapCat，对 LLM 返回假成功；reply / private 不受影响。默认 `false`。观察期专用，长期开会让 AgentContext 里堆满"假发出去"记录

无 env，但跟运行时相关：

- **好奇心 tick (SIGUSR1)** — 进程内不维护定时器，节奏甩到外面。`pnpm tick` = `kill -USR1 $(cat .bot.pid)` 戳一发，bot 收到信号 enqueue 一条 `{type:'curiosity_tick'}` 事件，渲染成常量 user message `[好奇心 tick] ...`，LLM 跟看到群消息一样的路径自己决定要不要 fetch_reddit。生产期定时由 cron / launchd / `while sleep 3600; do kill -USR1 $(cat .bot.pid); done` 之类外部调度负责。bot 启动时写 `.bot.pid`（gitignored），shutdown 时删除
- `LLM_PROVIDER_*_URL` / `_API_KEY` — provider 注册表，默认 provider 由 `LLM_DEFAULT_PROVIDER` 选
- `LLM_SCENARIO_*` — 媒体描述各场景的 provider/model 覆盖

---

## 启动流程（`src/index.ts`）

1. 连 Prisma → 注册媒体 RoutingProvider → jobQueue 启动
2. `createLlmClient()` 给 BotLoopAgent 用（默认 provider/model，与媒体路由独立）
3. `BotSnapshotRepo.load()` 从 `bot_agent_snapshot` 单行表恢复 AgentContext
4. `eventQueue` + `createDedupEnqueue(eventQueue)`（按 `messageRowId` 去重的统一入队 hook）
5. `registerNapcatHandlers({ onMessageReady })` 注册 NapCat 事件 handler（sync, no I/O）
6. `connectNapcat()` 真打开 WebSocket（必须在 `resolveTargetMetadataMaps` 之前 — 见下文 D2）
7. `resolveTargetMetadataMaps()` 一次性拉群名（`Promise.allSettled`，每调用 3s 超时）。私聊昵称走 per-event render，不预拉
8. `replayMissedMessages(lastWakeAt)` 多源回放，与 live 共享同一去重 set。私聊永远全量回放（不按 peerId 过滤）
9. `buildBotTools()` 装配 `wait` / `send_message` / `db_schema` / `db_read` / `web_search`；`buildBotSystemPrompt({groupIds, metadata})` 拼 prompt
10. `createBotLoopAgent({...})` + `agent.start()` — 进入 while 循环

## 主循环（`src/agent/bot-loop-agent.ts`）

```
while (!stopRequested) {
  drainEvents()          // BotEvent → context.appendUserMessage(renderedText)
  if (context 是空) await waitForEvent(); continue
  runRound()             // LLM call + execute tool calls
  persistSnapshot()      // 写 bot_agent_snapshot
  maybeCompact()         // token 阈值触发
  if (queue 空) await waitForEvent()  // 守 LLM 不空跑
}
```

---

## 模块地图

`src/bot/`
- `napcat.ts` — NCWebsocket client
- `core.ts` — `registerNapcatHandlers`（sync .on 注册）+ `connectNapcat`；多源 `processMessage(scope: GroupScope | PrivateScope)` 走相同 ingest 路径；持久化 + 媒体就绪 + onMessageReady
- `message-parser.ts` — NapCat segments → `ParsedSegment` 联合类型

`src/database/`
- `messages.ts` — `insertMessage()` upsert + invariant assert（qq_group / qq_private 必填字段）+ `freezeResolvedTextIfUnset` 一次冻结
- `agent-sql.ts` — agent `db_read` 的安全只读 SQL 校验 + 执行（多源，不再强制 `:group_id`）

`src/media/`
- `media-cache.ts` — `persistMediaReferences(scope: group|private)` 把媒体下载 + Media 表入库
- `ensure-message-ready.ts` — 等媒体描述 + 渲染 + 冻结 `resolved_text`
- `message-resolver.ts` — `resolveMessage` 把 segments 跑到带 mediaDescription 的形态

`src/agent/`
- `agent-context.ts` — single-bot AgentContext（red line 1）
- `event-queue.ts` — `InMemoryEventQueue<BotEvent>`
- `event.ts` — `BotEvent = napcat_message | napcat_private_message | wake | curiosity_tick`
- `dedup-enqueue.ts` — `createDedupEnqueue` 按 `messageRowId` 去重（red line 5 + replay×live 重叠保护）
- `render-event.ts` — 纯函数 `BotEvent → string`，多源标签 + 群名缺失裸 ID fallback（red line 5）
- `resolve-target-meta.ts` — 启动时一次性拉群名（`Promise.allSettled`，3s/调用，失败裸 ID）。私聊昵称走 per-event render，不预拉
- `llm-client.ts` — `AgentMessage <-> OpenAI ChatCompletion` 翻译
- `bot-system-prompt.ts` — 启动时一次拼装（使用 metadata maps，red line 5）
- `snapshot-repo.ts` — `bot_agent_snapshot` 单行持久化
- `compaction.ts` — `maybeCompactConversation`（red line 4 唯一前缀写口）
- `bot-loop-agent.ts` — 主循环
- `replay-missed.ts` — 启动时多源回放关机期间漏掉的消息（与 live 共享 dedup hook）
- `tool.ts` — Tool / ToolExecutor 接口
- `tools/*` — `wait` / `send_message` / `db_schema` / `db_read` / `web_search` / `fetch_reddit` / `fetch_url`

`src/ops/`
- `fetch-log.ts` — NDJSON 旁路日志 appendFile (容错), 不进 Prisma. 服务 `fetch_reddit` / `fetch_url` 的运维统计 (`logs/fetch.ndjson`)

`src/messaging/`
- `message-sender.ts` + `napcat-sender.ts` — 底层 NapCat 发送 + 重试（含群 + 私聊 reply）

`src/llm/`
- 媒体描述用的 provider routing（与 agent LLM 独立）

---

## Database

Prisma 7，PG driver adapter。当前 3 个 model：`Message` / `Media` / `BotAgentSnapshot`。

- `Message.groupId` 改 nullable 以容纳私聊（private 用 `sceneExternalId=peerId`）
- 永续上下文唯一持久化点：`bot_agent_snapshot` 单行表（`id=1`）

`Logging`: pino + pino-pretty。`createLogger(scope)` from `src/logger.ts`。

---

## LLM 配置

双 provider routing。Agent 自身的 LLM 调用走 default provider/model，媒体描述按场景路由。

```
LLM_DEFAULT_PROVIDER=claude
LLM_DEFAULT_MODEL=gpt-5.1

LLM_PROVIDER_CLAUDE_URL=http://127.0.0.1:8317/v1
LLM_PROVIDER_CLAUDE_API_KEY=sk-local
LLM_PROVIDER_OPENAI_URL=http://127.0.0.1:8317/v1
LLM_PROVIDER_OPENAI_API_KEY=sk-local
```

每个媒体场景可覆盖：

| 前缀 | 用途 |
|---|---|
| `LLM_SCENARIO_DESCRIBE_IMAGE_*` | 图片/表情包描述 |
| `LLM_SCENARIO_DESCRIBE_VIDEO_*` | 视频描述 |
| `LLM_SCENARIO_DESCRIBE_PDF_*` | PDF 描述 |
| `LLM_SCENARIO_TRANSCRIBE_AUDIO_*` | 音频转写 |

详见 `.env.example`。

---

## 工具清单（当前）

bot 通过工具自主决定：

- **`wait`** — 没事可做时调用，阻塞到下个 BotEvent。内嵌 `BOT_IDLE_HINT_MS` Promise.race：长时间没事件时返回 `[空闲提示] 已闲置约 X 分钟` 的 tool result + enqueue 一个 wake，让下一轮立即跑（LLM 自己决定要 fetch 还是继续 wait）
- **`send_message`** — 真发到群 / 私聊。target 必填。group target 经 `BOT_TARGET_GROUP_IDS` 白名单校验，越界返回 `{ok:false}`；private target 不走白名单（任意 userId 都接受，陌生 DM 已在 ingress 层挡掉）
  - target = `{type:'group', groupId, mentionUserId?}` 发群里
  - target = `{type:'private', userId}` 发私聊
  - `replyToMessageId` 可选，引用某条已存在消息
- **`db_schema`** / **`db_read`** — 查历史聊天（任一源）/ 媒体描述。多源后系统**不再**自动注入 `:group_id`，LLM 想限定单源时显式传（`params: {group_id: ...}` 或 `peer_id`）。`group_id` 走白名单校验；`peer_id` 任意 QQ 都接受。跨源 SELECT（无 ID 过滤）合法
- **`web_search`** — 仅在 `TAVILY_API_KEY` 配置时注册
- **`fetch_reddit`** — 拉 reddit RSS（subreddit 可选 + sort hot/top/new + limit 硬上限 10），每条 title ≤80 字 / summary ≤120 字硬截断。`AbortController` 超时走 `BOT_FETCH_REDDIT_TIMEOUT_MS`。每次调用写一行到 `logs/fetch.ndjson`
- **`fetch_url`** — 抓任意 URL：response body cap 256KB → cheerio 抽 title/desc/article/main/body → 8KB 截断 → 默认 LLM 摘成 ≤500 中文字 → 输出 ≤1500 字符 clamp。LLM 失败 fallback 到原文截断 + 错误标记。每次调用写一行到 `logs/fetch.ndjson`

---

## 渲染格式（当前）

`render-event.ts` 渲染规则：

- 群消息：`[群:名字 | 昵称(QQ:id) [@bot]] text`
- 群名缺失退化：`[群:id | 昵称(QQ:id)] text`
- 私聊：`[私聊 | 昵称(QQ:id)] text`（默认就是对 bot 说话，无 `[@bot]` tag，但允许 wait）

system prompt（`src/agent/bot-system-prompt.ts`）明示 LLM：

- 主动发也走工具，assistant content 只是内心想法
- 优先 wait，质量比频率重要
- 跨源知识共享 OK（同一意识），跨源 cue 人不行（target 显式）

---

## Prompts（当前）

所有静态 prompt 文本在 `prompts/`。当前用到：

- `prompts/characters/default.md` — bot 人设基座（`bot-system-prompt.ts` 通过 `loadPrompt` 加载）

旧的 reply-instruction / proactive-judge prompts 保留在目录里，single-context MVP 不再使用。媒体描述还在用图 / 视频 / PDF / 音频几个。

---

## 最近取舍 / 实现细节

- **`llm_traces` 表 MVP-2 移除**（零应用消费者）
- **D2: `napcat.connect()` 排在 `resolveTargetMetadataMaps` 之前**。中间窗口 live 入站消息可能被 replay-missed 再扫一次，靠 `createDedupEnqueue` 按 `messageRowId`（Message PK，跨 scene 全局唯一）去重 — replay 与 live 共享同一份 set，同条消息只进队一次

---

## Commands

```bash
pnpm dev              # tsx watch (hot reload)
pnpm build            # rm -rf dist && tsc
pnpm start            # node dist/index.js
pnpm db:generate      # prisma generate (after schema changes)
pnpm db:migrate       # prisma migrate dev
pnpm db:push          # prisma db push (no migration files)
pnpm test             # tsx --test src/**/*.test.ts
```

ESM-only（`"type": "module"` in package.json），所有本地 import 用 `.js` 扩展名。
