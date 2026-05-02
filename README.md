# qq-bot-v2

一个基于 NapCat + Node.js + Prisma + PostgreSQL 的 QQ 群聊机器人项目。

当前项目主要做几件事：

- 监听指定 QQ 群消息
- 持久化群消息、媒体引用和媒体理解结果
- 维护 root runtime snapshot，用于稳定重建群聊上下文
- 通过已配置的 OpenAI-compatible LLM provider 生成媒体描述和 `@bot` 回复
- 对普通群消息做 runtime 归类、审计和主动候选观测，但默认不真实主动发言

## 核心要义：永续上下文

「永续上下文」是这个项目的设计中枢，不是「上下文窗口很长」的修辞。

**定义**：让 LLM 历史 prefix 在多次调用之间保持位级稳定，最大化 prompt cache 命中率，把对话的有效寿命无限延长。

**为什么重要**：Claude/OpenAI 的 prompt cache 按 prefix 前缀匹配命中——命中时 cached input token 计费极低、首 token 极快；未命中则整段重新计费、重新 attention。如果每轮都让历史前缀漂移（重排消息、重写媒体描述、改 system prompt），命中率被砸到 0，成本和延迟同步爆炸。反之只要前缀稳，bot 可以「越聊越便宜」，24/7 长开线和高频触发才在经济上可行。

**架构上的五条不变量**（破坏其中任何一条都视为回归）：

1. **owned AgentContext 是历史的真身**。`src/agent/agent-context.ts` 的 `AgentContext` 持有 scene 的 `AgentMessage[]`，LLM 每次调用看到的就是 `getSnapshot().messages`。持久形态 == 运行时形态：`scene_agent_contexts.snapshot` 直接序列化这个数组，重启 = 把数组 splice 回内存。`messages` 表保留为入站事实账本（审计 / 媒体 resolve / 引用查找 / 恢复源），不双写、不投影。
2. **prefix / tail 二分用于观测**。`src/agent/context-frame.ts` 在每次 LLM 调用时把当轮 history 切成稳定 prefix（system + 摘要头部）和易变 tail（窗口 + trigger），分别记录 `prefixHash` / `tailHash` 写入 `LlmTrace`，事后能在 admin-web 上核对 cache 命中。
3. **append-only + append-time 冻结**。摄入入站消息走 `src/agent/scene-message-ingestor.ts`：append 时刻按 `messages.resolvedText` 当时的形态渲染成 `AgentMessage`，之后即使 messages 行被回填也不重写 AgentContext。bot 已发送回复以 `model` role append，不做文本拼接。控制工具（`final_answer`）不入账，由发送成功路径写 model role，发送失败时历史不会出现「假回复」。
4. **compaction 是计划性的破坏性操作**。`src/conversation/compaction.ts` 的 `maybeCompactConversation(context)` 是唯一改写历史的路径：在 AgentContext 上 `replaceMessages([summaryHead, ...keptTail])` 原子替换，kept 部分字节保持不变，前缀 hash 切换一次后再次稳定。token-based 阈值（默认 12k token），`previousSummary` 是合并输入而非 append，cut 边界不切开 `tool_calls + tool_results` 三元组。post-send 触发，try/catch wrap 不污染已 sent reply。
5. **决定性重放**。同一个 scene 在任意时刻 `getSnapshot()` 出来的 messages 必须 byte-identical（输入相同时）——这是 cache 命中的数学前提，不是好习惯。

观测面在 admin-web 的 `/llm-traces` 里，按 sceneId 聚合 `prefixHash` 切换次数和 `cached_tokens` 占比；持久形态在 `scene_agent_contexts` 表（一条记录 = 一个 scene 的全部 LLM 可见历史）。扩展规则同步写在 `CLAUDE.md` 的 *Perpetual Context Contract* 章节，做出影响 prefix 的改动时务必先读那一节。

## 功能概览

- 监听指定群消息并写入 PostgreSQL
- 启动后自动补拉最近一批群历史消息；补拉只入库/补 runtime 状态，不补发回复
- 缓存图片、视频、语音、PDF/文件等媒体，异步生成描述或转写
- `@bot` 走 root runtime + reply record 链路，当前实时主路径会尽快生成并引用原消息回复
- 回复发送支持 dry run，便于本地验证生成和持久化而不真实发群消息
- root runtime snapshot 保存稳定上下文、未读消息、cue、sender continuity 和主动候选 artifact
- 普通群消息可写入 `reply_audits`，主动候选默认是 dry-run/artifact-only，不走真实 `send_message`
- 内置轻量 HTTP API，提供 playground replay 和媒体重新分析接口

## 环境要求

- Node.js 20+
- pnpm 10+
- PostgreSQL
- NapCat，并开启 WebSocket
- 一个 OpenAI-compatible LLM endpoint，或本地兼容网关

## 安装

```bash
pnpm install
```

## 环境变量

先复制一份环境变量模板：

```bash
cp .env.example .env
```

然后按实际环境修改 `.env`。下面是最小可启动配置形态，实际可直接参考 `.env.example`：

```env
# PostgreSQL
DATABASE_URL=postgresql://qq_user:qq_password@127.0.0.1:5432/qq_bot_v2

# NapCat
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_ACCESS_TOKEN=your_token_here

# 监听的群号，多个用逗号分隔
GROUP_IDS=123456789,987654321

# Bot 自己的 QQ 号
SELF_NUMBER=10001

# LLM provider 注册表。当前代码启动时要求有默认 provider 和 model。
LLM_DEFAULT_PROVIDER=claude
LLM_DEFAULT_MODEL=gpt-5.1
LLM_PROVIDER_CLAUDE_URL=http://127.0.0.1:8317/v1
LLM_PROVIDER_CLAUDE_API_KEY=sk-local

# 可选
NODE_ENV=development
BOT_REPLY_DRY_RUN=true
BOT_PROACTIVE_DRY_RUN=true
BOT_AMBIENT_AUDIT_ENABLED=true
REPLY_MEDIA_TIMEOUT_MS=15000
JOB_INTER_DELAY_MS=200
```

### 必填项说明

- `DATABASE_URL`: PostgreSQL 连接串
- `NAPCAT_WS_URL`: NapCat WebSocket 地址
- `NAPCAT_ACCESS_TOKEN`: NapCat 鉴权 token
- `GROUP_IDS`: 要监听的 QQ 群号列表
- `SELF_NUMBER`: 机器人自己的 QQ 号
- `LLM_DEFAULT_PROVIDER`: 默认 LLM provider 名称
- `LLM_DEFAULT_MODEL`: 默认 LLM model
- `LLM_PROVIDER_<NAME>_URL`: 对应 provider 的 OpenAI-compatible base URL
- `LLM_PROVIDER_<NAME>_API_KEY`: 对应 provider 的 API key

### LLM 路由说明

当前代码使用 OpenAI-compatible provider 注册表。`claude`、`openai`、`gemini` 都只是 provider key，真正请求会走各自配置的 `LLM_PROVIDER_<NAME>_URL`。

常见本地配置是把多个 provider key 都指向同一个本地统一网关：

```env
LLM_DEFAULT_PROVIDER=claude
LLM_DEFAULT_MODEL=gpt-5.1
LLM_PROVIDER_CLAUDE_URL=http://127.0.0.1:8317/v1
LLM_PROVIDER_CLAUDE_API_KEY=sk-local

LLM_PROVIDER_OPENAI_URL=http://127.0.0.1:8317/v1
LLM_PROVIDER_OPENAI_API_KEY=sk-local
```

每个场景可以单独覆盖 provider 和 model：

- `LLM_SCENARIO_DESCRIBE_IMAGE_PROVIDER`
- `LLM_SCENARIO_DESCRIBE_IMAGE_MODEL`
- `LLM_SCENARIO_DESCRIBE_IMAGE_FALLBACK_PROVIDER`
- `LLM_SCENARIO_DESCRIBE_IMAGE_FALLBACK_MODEL`
- `LLM_SCENARIO_DESCRIBE_VIDEO_PROVIDER`
- `LLM_SCENARIO_DESCRIBE_VIDEO_MODEL`
- `LLM_SCENARIO_DESCRIBE_PDF_PROVIDER`
- `LLM_SCENARIO_DESCRIBE_PDF_MODEL`
- `LLM_SCENARIO_TRANSCRIBE_AUDIO_PROVIDER`
- `LLM_SCENARIO_TRANSCRIBE_AUDIO_MODEL`

Agent 回复默认继承 `LLM_DEFAULT_PROVIDER` / `LLM_DEFAULT_MODEL`，也可以用下面几个变量单独覆盖：

- `LLM_AGENT_BASE_URL`
- `LLM_AGENT_API_KEY`
- `LLM_AGENT_MODEL`

如果配置了 `TAVILY_API_KEY`，agent 工具里会启用 `web_search`。

## 数据库初始化

首次启动前先准备数据库表结构。

推荐方式：

```bash
pnpm db:migrate
```

如果只是本地快速同步 schema，也可以：

```bash
pnpm db:push
```

如需重新生成 Prisma Client：

```bash
pnpm db:generate
```

当前主要表包括：

- `messages`: 入站群消息事实账本
- `media`: 媒体二进制缓存和描述结果
- `llm_traces`: LLM 调用 trace（含 prefix/tail hash 用于 cache 观测）
- `scene_agent_contexts`: 永续上下文真身。每个 scene 一条记录, `snapshot.messages` 就是 LLM 可见的 `AgentMessage[]`
- `assistant_turns`: 旧 assistant turn 表，启动时迁移到 reply record（即将退役）
- `reply_records`: 当前回复意图、生成文本、发送状态和幂等记录
- `reply_audits`: 回复/主动候选审计记录
- `agent_runtime_snapshots`: agent runtime 全局 session snapshot（cursors、未读等，与 scene_agent_contexts 职责区分）

## 启动方式

### 开发模式

```bash
pnpm dev
```

开发模式会使用 `tsx watch` 监听源码变更并自动重启。

### 生产构建

先构建：

```bash
pnpm build
```

再启动：

```bash
pnpm start
```

## 使用说明

### 1. 启动依赖服务

确保以下服务都已经可用：

- PostgreSQL
- NapCat WebSocket
- `.env` 中配置的 LLM endpoint

说明：

- `admin-web` 当前为临时禁用状态，不属于这一阶段的支持面。

### 2. 配置群号和机器人账号

在 `.env` 中填写：

- `GROUP_IDS`: 需要监听的群
- `SELF_NUMBER`: 当前机器人 QQ 号

机器人只会处理 `GROUP_IDS` 中的群消息。

### 3. 启动机器人

运行：

```bash
pnpm dev
```

启动成功后，程序会：

- 连接数据库
- 注册 LLM routing provider
- 启动 HTTP API，默认端口是 `BOT_API_PORT` 或 `3101`
- 启动内存任务队列
- 恢复 root runtime snapshot
- replay 持久化消息 delta 到 runtime，但不补发历史回复
- 连接 NapCat
- 迁移旧 `assistant_turns` 到 `reply_records`
- 恢复可恢复的 `reply_records`
- 启动 passive runtime 恢复路径
- 对已配置群执行最近历史消息补拉

### 4. 在群里使用

项目当前更偏向“消息接入 + 媒体理解 + reply record + root runtime 永续上下文”。

你可以这样验证是否正常工作：

- 在配置的 QQ 群里发送文本消息
- 发送图片、视频、语音或文件消息
- 查看终端日志是否输出 `群友发言已入库`
- 查看 PostgreSQL 中 `messages`、`media`、`root_runtime_snapshots` 是否有新增或更新
- 如果 `BOT_REPLY_DRY_RUN=true`，查看日志和 `reply_records` / `reply_audits`，不要期待群里真实发出 @ 回复
- 如果 `BOT_REPLY_DRY_RUN=false`，`@bot` 后应通过 `reply_to_message` 引用原消息回复

## `@bot` 回复链路

当前实时 `@bot` 主路径不是 30 秒聚合窗口。

实际链路是：

1. 收到群消息
2. 解析消息、处理媒体引用、写入 `messages`
3. 将已入库消息投递给 root runtime
4. root runtime 更新 `root_runtime_snapshots`
5. 如果消息包含 `@SELF_NUMBER`，构造 strong anchored reply opportunity
6. 因为启动时 `replyExecutionEnabled=true`，实时主路径直接进入 `ReplyExecutor`
7. `ReplyExecutor` 生成回复，创建或复用 `reply_records`
8. 如果不是 dry run，通过 NapCat `reply_to_message` 发送
9. 发送成功后，runtime 标记相关 cue 已回复，并把 assistant turn 写回上下文

当前约束：

- 实时 `@bot` 会尽快处理当前消息，不等待 30 秒合并
- `BOT_REPLY_DRY_RUN=true` 时仍会生成和记录，但不会真实发群消息
- 回复幂等依赖 `reply_records.replyIntentId`
- 历史补拉和 startup replay 不会补发回复
- passive mailbox 仍存在，但主要用于启动恢复、手动 enqueue 或禁用实时 executor 后的 fallback 路径
- passive mailbox 默认窗口是 `1_000ms`，不是 README 旧版本写的 30 秒
- passive processor 里同一 batch 最多处理 2 个 sender 线程，超出的 sender 会进入下一轮

## 普通群消息与主动候选

普通群消息也会进入 root runtime，并更新上下文和未读状态。

默认行为：

- 普通消息不会真实主动发言
- `BOT_AMBIENT_AUDIT_ENABLED=true` 时会写审计
- 主动候选只走 dry-run/artifact-only 路径
- `BOT_PROACTIVE_DRY_RUN` 控制独立 `send_message` 的真实发送开关；当前 runtime 默认不会把普通消息升级成真实 `send_message`
- proactive policy 和 proactive judge 只影响候选生成/观测，不改变 `@bot` 必回逻辑

相关配置：

- `BOT_AMBIENT_AUDIT_ENABLED`
- `BOT_AMBIENT_REPLY_BASE_PROBABILITY`
- `PROACTIVE_ACTIVE_CHAT_MESSAGE_THRESHOLD`
- `PROACTIVE_ACTIVE_CHAT_WINDOW_MS`
- `PROACTIVE_COOLDOWN_MS`
- `PROACTIVE_GENERATION_BUDGET_PER_HOUR`
- `PROACTIVE_CANDIDATE_BUDGET_PER_DAY`
- `PROACTIVE_JUDGE_ENABLED`
- `PROACTIVE_JUDGE_TIMEOUT_MS`
- `PROACTIVE_JUDGE_MAX_CALLS_PER_HOUR`

## 常用命令

```bash
pnpm dev          # 开发模式启动
pnpm build        # 构建 TypeScript
pnpm typecheck    # 只做 TypeScript 检查
pnpm lint         # 当前等价于 pnpm typecheck
pnpm test         # 运行 src/**/*.test.ts
pnpm start        # 启动构建产物
pnpm db:generate  # 生成 Prisma Client
pnpm db:migrate   # 执行 Prisma 迁移
pnpm db:push      # 直接同步 schema 到数据库
```

`admin:dev`、`admin:build`、`admin:start` 当前会直接报错退出，因为 `admin-web` 暂时禁用。

## 目录结构

```text
.
├── prisma/               # Prisma schema 和迁移文件
├── prompts/              # persona、回复、媒体描述、主动判断等 prompt
├── src/
│   ├── agent/            # multi-turn agent loop、工具、OpenAI-compatible 调用
│   ├── bot/              # NapCat 接入、消息处理
│   ├── config/           # 环境变量、agent profile、prompt loader
│   ├── conversation/     # reply record、审计、压缩、恢复、passive mailbox
│   ├── database/         # Prisma client、消息读写、agent SQL
│   ├── jobs/             # 媒体描述任务
│   ├── llm/              # OpenAI-compatible provider 和场景路由
│   ├── media/            # 媒体缓存、解析、序列化、描述读取
│   ├── messaging/        # NapCat 发送抽象和消息 segment 构造
│   ├── queue/            # 内存任务队列
│   ├── responder/        # 回复生成、上下文构建、agent session
│   ├── runtime/          # root runtime、reply decision、executor、proactive judge
│   ├── server/           # HTTP API、playground、媒体重分析
│   ├── types/            # 共享类型
│   └── utils/            # 通用工具
└── .env.example          # 环境变量示例
```

## 排查问题

### 启动时报缺少环境变量

检查 `.env` 是否存在，并确认以下字段都已填写：

- `DATABASE_URL`
- `NAPCAT_WS_URL`
- `NAPCAT_ACCESS_TOKEN`
- `GROUP_IDS`
- `SELF_NUMBER`
- `LLM_DEFAULT_PROVIDER`
- `LLM_DEFAULT_MODEL`
- `LLM_PROVIDER_<NAME>_URL`
- `LLM_PROVIDER_<NAME>_API_KEY`

### 能启动但没收到群消息

重点检查：

- NapCat WebSocket 地址和 token 是否正确
- 群号是否包含在 `GROUP_IDS` 中
- NapCat 是否已经登录目标 QQ 账号
- 日志里是否出现 `WebSocket 开始连接`、`NapCat 连接成功`、`群友发言已入库`

### `@bot` 生成了但群里没发

重点检查：

- `BOT_REPLY_DRY_RUN` 是否为 `true`
- `reply_records.execution_state` 是 `dry_run`、`sent` 还是 `failed`
- `reply_audits` 是否有对应 `dry_run_intent` 或失败记录
- NapCat 是否允许当前账号发送群消息

### LLM 或媒体描述没生效

重点检查：

- `LLM_DEFAULT_PROVIDER` 是否能在 `LLM_PROVIDER_<NAME>_URL` / `API_KEY` 中找到对应配置
- provider URL 是否是 OpenAI-compatible `/v1` endpoint
- 对应 model 是否在网关中可用
- 媒体描述任务是否进入队列，`media.description_raw` 是否更新
- 场景覆盖变量是否引用了不存在的 provider key

### 普通消息没有主动发言

这是当前默认边界。普通群消息默认只写 runtime 状态、审计和主动候选 artifact，不真实 `send_message`。

### HTTP API 端口冲突

默认 HTTP API 端口是 `3101`。如需修改：

```env
BOT_API_PORT=3102
```

## 最低启动流程

```bash
pnpm install
cp .env.example .env
# 修改 .env，至少填好数据库、NapCat、GROUP_IDS、SELF_NUMBER、LLM provider
pnpm db:migrate
pnpm dev
```
