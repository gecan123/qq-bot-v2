# 运维

命令以 `package.json` 为事实来源。

## 事实来源

- 代码、schema、测试和实际日志优先于过期文档。
- `.env.example` 负责当前环境变量示例。
- `package.json` 负责命令和依赖。
- `prisma/schema.prisma` 负责数据库契约。
- `src/index.ts` 负责启动顺序。
- `src/agent/tools/index.ts` 负责 bot 工具注册。

## 常用命令

### 重置 Agent 持久状态（本地调试）

先停止 bot，再运行：

```bash
pnpm agent:reset-state -- --scope context
pnpm agent:reset-state -- --scope knowledge
pnpm agent:reset-state -- --scope all
```

`context` 删除 `bot_agent_ledger_entries`、`bot_agent_checkpoint`、`bot_agent_runtime_state` 和 `bot_agent_goal`，再重建空 runtime singleton，保留 workspace。`knowledge` 只删除 `data/agent-workspace/{memory,journal,life,notebook}`，不连接数据库；其中 `journal` 只是遗留目录清理项。`all` 执行 context 清理，并删除 `data/agent-workspace/` 下除契约文件 `README.md`、`.gitignore` 外的全部 Agent 生成内容，包括长期知识、普通笔记、runtime 状态、浏览器 profile/artifact、草稿和缓存。三种 scope 都保留消息/媒体事实账本、表情池和运维日志。空 ledger 冷启动不会把既有消息拼成旧 prompt history。

scope 必须显式提供，命令可重复执行；标准 package script 已内置破坏性确认参数，检测到 `.bot.pid` 对应进程仍存活时会拒绝运行。

从旧 snapshot 版本 clean cutover 时不做历史迁移：先部署并生成新 schema，停止旧 bot，执行上面的显式 reset，再启动新版本。不要 dual-write 或从 `messages` / 日志重建旧 transcript。

```bash
pnpm dev
pnpm dev:once
pnpm agent:dev
pnpm agent:dev:once
pnpm qq:gateway
pnpm feishu:gateway
pnpm media:worker
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm repo-check
pnpm web:dev
pnpm web:test
pnpm web:typecheck
pnpm web:build
pnpm agent:doctor
pnpm agent:metrics
pnpm agent:daily-metrics
pnpm agent:memory-check
pnpm agent:ledger-check
pnpm agent:context
pnpm agent:reset-state -- --scope context
pnpm --silent agent:context -- --json
pnpm db:generate
pnpm db:migrate
pnpm db:push
pnpm browser:controller
pnpm toollog
pnpm toollogf
```

### WebAdmin（本机管理模式）

`apps/admin-web` 的“现在”首页展示实时活动、Goal commitment 与最近工具进展，其他观察页面提供 Ledger、原始事件、生命状态、Memory、跨平台 Conversations/Media、指标和健康下钻。Health 的自动刷新只读 head/count/checkpoint 元数据；完整 canonical replay 必须由 operator 点击 Deep Integrity 手动触发，并展示最近检查时间、耗时和摘要。“管理操作”页面只开放固定 `reset_state`：选择 `context`、`knowledge` 或 `all`，且没有自动恢复路径。

观察数据流是：

```text
Browser → TanStack Start Server Function → read service → PostgreSQL
```

管理操作数据流是：

```text
Browser → validated Server Function → operation service
        → Bot-stopped guard → typed src/ops mutation
        → local run state / audit log
```

每次写入必须先生成只读预览。operator 检查影响范围后，输入服务端返回的精确确认短语；服务端再次确认 Bot 已停止，重新生成预览并核对 SHA-256 指纹，状态漂移时返回 `preview_stale` 并要求重新预览。WebAdmin 不会发送 signal，也不会自动停止或重启 Bot。任意写任务运行时拒绝第二个任务。

任务状态是 `queued`、`running`、`succeeded`、`failed` 或 `interrupted`。当前 state 原子写入 `logs/admin-operation-state.json`，每次 transition 追加到 `logs/admin-operations.ndjson`；日志只保存有界结果摘要，不记录长期状态正文、密钥或完整数据库 payload。WebAdmin 重启时，上一进程遗留的 active run 标记为 `interrupted`；operator 必须检查当前状态后再决定是否重试，系统不会自动续跑。

实时 phase 另由 Bot Runtime 原子写入 `logs/agent-activity.json`。WebAdmin 会同时核对 `.bot.pid`；PID 缺失、不可达或不匹配时不展示旧文件为“正在执行”。该观察面不参与 replay，Bot 重启后才会开始产生新版实时状态。

首次运行先生成根 Prisma client，并创建 app 私有环境文件：

```bash
pnpm db:generate
cp apps/admin-web/.env.example apps/admin-web/.env.local
pnpm web:dev
```

`apps/admin-web/.env.local` 只需提供 `DATABASE_URL`，不得提交。开发服务器默认绑定 `127.0.0.1:20030`。当前没有管理员鉴权，禁止改为非可信接口监听、直接公开部署或经未受控反向代理暴露。

常用静态验证：

```bash
pnpm web:test
pnpm web:typecheck
pnpm web:build
pnpm repo-check
pnpm bench:ledger-commit
```

构建不连接数据库；真实页面加载才通过 Server Function 使用 `DATABASE_URL`。观察 feature 不允许更新 ledger、runtime state、checkpoint、Goal、消息、媒体或 workspace side-data。唯一 mutation adapter 是 `features/operations/operations.server.ts`，它不能调用 shell、package script、任意 SQL 或接受路径输入。WebAdmin run state、审计日志、页面 cache 和查询 DTO 都不是 replay source，不能重建或改写 `AgentContext`。

### Agent Context 占用分析

默认输出适合人在终端阅读；需要机器可读结果时使用 `--json`：

```bash
pnpm agent:context
pnpm --silent agent:context -- --json
```

JSON 报告带当前为 `2` 的 `schemaVersion`，总占用字段是 `estimatedSnapshotTokens`。机器消费时必须保留 `--silent`，否则 pnpm banner 会混入 stdout，结果不再是纯 JSON。

报告的 message context 来自 canonical `bot_agent_ledger_entries` 与 `bot_agent_runtime_state`：命令以只读方式重建 ledger projection 和当前 working projection。`logs/context-surface.json` 是 bot 最近一次启动时写出的 schema v2 固定 token 快照，只含 system identity、system prompt 和可见工具声明的估算合计，不含正文，也不参与 replay。消息分类是对 working messages 的单遍本地 UTF-8 近似，不保证与某次 provider request JSON 逐字节一致；`Latest provider usage` 是最近一次 `agent.chat` 的独立 provider 实测样本，两者用途不同，不应视为同一时刻或强行对齐。

该命令只读：不调用 LLM，不启动 QQ、NapCat、browser 或 MCP，也不写数据库、checkpoint、runtime state 或 ledger，因此不会给 LLM context 增加消息。surface 状态只有 `available`、`missing` 和 `invalid`，不做 PID 存活判定；快照时间以 `generatedAt` 为准。surface 缺失或损坏时，命令仍输出 message context，但固定分类和总占用降级为 `n/a`。终端报告还会按估算 token 展示 tool result 的 top contributors，便于定位占用最大的工具返回。

## 本地运行

`LLM_FALLBACK_MODEL` 默认不配置。需要时填写与 `LLM_DEFAULT_MODEL` 使用同一 `LLM_DEFAULT_PROVIDER` wire path 的模型；它只接管 overload/5xx，不用于鉴权、限流、参数错误或 context overflow。

- 从仓库根目录启动，确保 `.bot.pid`、logs、prompts 和相对路径稳定。
- `pnpm dev` 通过 `src/platform.ts` 启动多进程 watch 模式；`pnpm dev:once` 启动同一组进程但不监听文件变化。supervisor 等待 Media Worker、QQ Gateway，以及按配置启用的 Feishu Gateway 和 Browser Controller 健康后，才启动 Agent Core。短期调度在 Agent Core 内部启动，LLM 请求由 Agent Core 与 Media Worker 直接发给 provider。
- `pnpm dev:all` 在 watch 模式下额外启动 WebAdmin；`pnpm dev:all:once` 不监听 Bot 源码变化。它们只合并本地生命周期，WebAdmin 不参与 ingress 或 Agent 调度。WebAdmin 的“进程日志”页按固定进程白名单读取 `logs/processes/*.log` 最后 512 KiB / 500 行，不能提交路径、命令或写入日志。
- 各进程标准输出和错误分别追加到 `logs/processes/<process>.log`；终端只显示 supervisor 生命周期，平台 Gateway 日志不再混进 Agent Core 日志。
- `pnpm build && pnpm start` 使用 `dist/platform.js` 启动编译后的同一平台。`pnpm agent:dev`、`pnpm agent:dev:once` 和 `pnpm agent:start` 保留单进程兼容入口，主要用于聚焦调试。
- `pnpm qq:gateway`、`pnpm feishu:gateway`、`pnpm media:worker` 可以单独启动服务；不要与占用同一端口的 platform supervisor 同时运行。
- `BOT_*_URL` 内部服务地址只接受带显式端口的 loopback HTTP origin；这些端点没有远程认证，不能绑定到 `0.0.0.0` 或非可信网络。
- `.bot.pid` 只供 WebAdmin 和破坏性运维命令判断 Bot 是否仍在运行，不接受产品控制信号。
- `pnpm agent:daily-metrics -- --date YYYY-MM-DD` 按日报告主 Agent 的 token/cache 和工具调用，不再维护 rest 专门指标；该命令属于 operator 入口，不暴露给主 Agent。

### 飞书接入

飞书默认关闭。启用时配置 `BOT_FEISHU_ENABLED=true`、`BOT_FEISHU_APP_ID`、`BOT_FEISHU_APP_SECRET`，并用逗号分隔的 `BOT_FEISHU_GROUP_IDS` 明确允许群聊 `chat_id`。可选 `BOT_OWNER_FEISHU_OPEN_ID` 只把主人飞书身份与 QQ 主人统一为 Memory 的 `owner`；当前 `/goal` 和审批控制面仍只接受主人 QQ 私聊。`BOT_FEISHU_GATEWAY_URL` 默认是 `http://127.0.0.1:37927`，必须保持 loopback。

飞书应用需在开放平台启用机器人能力、长连接事件订阅和消息/资源所需权限。Gateway 用官方 SDK 的 WebSocket 接收事件，图片和文件下载后进入现有 `media` / `media_blobs`，单文件上限 20MB。收到的 `receive_v1` 若 `update_time > create_time` 会保存为 edit；首次真实切换还需验证用户后续编辑是否由飞书再次投递。当前不导入旧飞书历史，也不在重启后补拉停机窗口；不要把 Feishu Gateway 的 ready 状态理解成历史已对账。

## 短期调度

`ScheduleRuntime` 默认把版本化状态原子写入 `data/agent-workspace/runtime/schedules.json`，可以改为其他受控路径：

```bash
BOT_SCHEDULE_STATE_PATH=data/agent-workspace/runtime/schedules.json
```

Agent Core 启动时完整读取和校验 v2 store，再为每个一次性 `at` / `afterSeconds` job 挂 timer；schedule tool 直接调用同进程 `ScheduleRuntime`。停机期间已经到期的 job 在恢复后触发它唯一的 occurrence，不做周期合并。未知 version、损坏 JSON 或非法 job 会让 Agent Core 启动显式失败；从含 recurring job 的 v1 store 切换时应在平台停止后由 operator 清理旧 schedule 状态。Timer、处理或 event delivery 异常由 `SCHEDULE` logger 记录 `scheduleId` 和原始错误。

同目录还维护 `${BOT_SCHEDULE_STATE_PATH}.occurrences` 和 `${BOT_SCHEDULE_STATE_PATH}.deliveries`。到期流程先持久化 occurrence 和 pending delivery，再删除 active job 并直接 enqueue `scheduled_wake`；该事件写入 canonical ledger 后才删除 pending delivery。启动时会跳过仍 active 的 pending 项、重放尚未提交的 delivery，并根据 canonical ledger 清理已经提交的项，因此不需要独立 Scheduler、Agent Events HTTP 端点或内部调度 URL。graceful shutdown 会等待串行 mutation 并清除 timer handle，但不删除尚未完成的持久 job 或 pending delivery。不要在运行期间手工编辑这三个文件。

## Owner Goal

配置的 owner 与 bot 的 QQ 私聊是最高优先级 Goal 控制面。Agent 也可以通过 `goal action=create_self` 创建自己的持久 Goal，但不能改写或放弃 owner Goal；新的 owner Goal 会直接抢占当前 self Goal。owner 命令必须从消息开头精确使用 `/goal`：

```text
/goal
/goal 完成目标描述
/goal --tokens 50000 完成目标描述
/goal pause
/goal resume
/goal resume --tokens 80000
/goal clear
```

不带参数用于查询。新的 owner Goal 不会覆盖仍未完成的 owner Goal，必须先完成或 `clear`；但会抢占 self Goal。达到 token budget 后状态变为 `budget_limited`；恢复时的新预算必须大于已经使用的 token。`clear` 是取消而非物理删除，便于 revision 和迟到调用保持单调、可判旧。Goal 跨重启继续，missed owner 私聊命令会在普通 mailbox replay 前按 message row 顺序补应用。

self Goal 默认 1,000,000 tokens，允许自行指定到 10,000,000；滚动 24 小时最多 64 个、相邻创建至少 60 秒。两项限制只用于阻止失控循环，不是日常行为准入。创建 self Goal 必须同时写入包含具体动作、选择理由和预期证据的 `currentCommitment`；完成当前步骤或证据使路线失效时用 `replan` 更新。Agent 用 `abandon_self` 放弃自己的 Goal 时必须保留理由；该动作不能作用于 owner Goal。

## Owner 审批

开发默认是 `BOT_APPROVAL_MODE=thin`：只审批网站 `publish` 和未列入 MCP `readOnlyTools` 的调用。本地 memory/notebook/Life Journal/workspace 删除、网站本地删除和 skill 安装直接执行，不再打断迭代。`strict` 恢复这些本地审批，`off` 关闭统一审批 hook；三种模式都不会改变工具自身的 revision、路径、target、schema、allowlist 和 timeout 边界。

需要审批的调用第一次会返回 `approval_required`。标准流程是：

1. 记录返回的 `approvalId`、原因和过期时间。
2. owner 在与 bot 的 QQ 私聊里发送精确文本 `批准 <approvalId>`，不要附加其他文字。
3. Agent 用 `inbox` 找到这条私聊的 `rowId`，调用 `approval action=approve approvalId=<id> messageRowId=<rowId>`。
4. 以完全相同的 tool name 和 args 重试原调用。审批在这次成功授权时即消费，再次执行必须重新申请。

审批状态默认写入 `data/agent-workspace/runtime/approvals.json`，可用 `BOT_APPROVAL_STATE_PATH` 修改。owner 未配置、证据不是 owner 私聊、证据早于请求或晚于过期时间、参数变化、重复消费都会被拒绝。

## 薄审计模式

默认配置适合快速迭代：

```bash
BOT_TOOL_AUDIT_MODE=side_effects
BOT_TOOL_AUDIT_DB_ENABLED=false
BOT_APPROVAL_MODE=thin
```

`side_effects` 只把写操作和外部动作记录到本地 `logs/tool-calls.ndjson`；普通读取不记录。`all` 用于集中排障，`off` 完全关闭 tool trace。Postgres `agent_tool_calls` 只有显式打开 `BOT_TOOL_AUDIT_DB_ENABLED=true` 才写入。token usage 仍是独立的性能观测，不参与权限判断。

## Deferred MCP

复制 [MCP 配置示例](./examples/mcp-servers.json) 到不提交的 bot 自管目录，例如 `data/agent-workspace/config/mcp-servers.json`，再设置：

```bash
BOT_MCP_CONFIG_PATH=./data/agent-workspace/config/mcp-servers.json
BOT_MCP_SCHEMA_SNAPSHOT_DIR=data/agent-workspace/runtime/mcp-schemas
```

配置文件只支持本机 stdio server；`command` / `args` 由 operator 固定，运行时不用 shell。`env` 适合非敏感固定值；密钥优先通过 `inheritEnv` 写变量名，再由 bot 进程环境提供真实值。`readOnlyTools` 必须使用 server 暴露的原始 tool name，未列出的调用默认需要 owner 审批。

重启后通过 `help action=describe capability=mcp_connectors` 查看入口，再按以下顺序直接 invoke：

```text
invoke tool=mcp args={"action":"servers"}
invoke tool=mcp args={"action":"tools","server":"example"}
invoke tool=mcp args={"action":"call","tool":"mcp__example__search","arguments":{"query":"..."}}
```

`servers` 不启动子进程；第一次 `tools` / `connect` / `call` 才连接。`tools` 默认每页 5 项，返回 `nextOffset` 时继续分页。schema 快照带 `schemaVersion` 哈希；它是调试和变更审计依据，不是 replay 数据源。当前不支持 Streamable HTTP、resources、prompts 或远端自动安装。
- logs 写在 `logs/` 下，是运维证据，不是 replay 输入。
- 仓库对外展示的机器可读时间统一为北京时间 `YYYY-MM-DDTHH:mm:ss.SSS+08:00`；PostgreSQL `timestamptz` 仍保存绝对时刻。
- 启动时当前 system prompt 会写入 `logs/system-prompt.txt`，便于检查。
- 启动恢复会先连接 NapCat，并等待 QQ 首次群历史 backfill 的所有来源尝试完成，再执行已有数据库事实的 missed-message replay；单群补拉失败记录 source-level error，其余来源和 replay 继续。飞书当前只从 WebSocket ready 后接收新事件，不做历史导入或重启补拉。
- `SIGINT` / `SIGTERM` 会触发幂等 graceful shutdown：停止 ingress、中止未提交 compaction、等待当前 round、drain backfill/飞书会话队列、停止 jobs、同步最终 Goal/runtime 状态，最后断开数据库。关闭 NapCat WebSocket 时会先禁用 SDK 自动重连，避免退出流程被重新建立的连接拖住；单阶段超时或失败会记录 `shutdown_phase_failed`，并继续后续清理。

## 数据保留

- 后台任务状态默认原子写入 `data/agent-workspace/runtime/background-tasks.json`，可用 `BOT_BACKGROUND_TASK_STATE_PATH` 改路径。重启时普通 running 会变成 `interrupted` 并通知 Agent。
- 短期调度独立保存在 `data/agent-workspace/runtime/schedules.json`，可用 `BOT_SCHEDULE_STATE_PATH` 改路径；它不再是 background task recovery descriptor。
- 图片任务的 metadata/预览可随 registry 保留，但 `ephemeralRef` 属于进程内 OutboundCache；重启后结果会明确标记失效，需重新生成，不能假装原图仍可发送。
- MCP schema 快照默认位于 `data/agent-workspace/runtime/mcp-schemas/*.json`；每次成功 discovery 原子覆盖当前版本。这里不保存远端调用结果或认证密钥。

- Agent Core 启动后异步执行一次 retention，并在每天北京时间 03:00 以 single-flight 方式再次执行；清理不会阻塞 Bot 启动，停机时会取消 timer 并有界等待在途任务。
- 每次清理删除 `BOT_INBOUND_RETENTION_DAYS` 窗口之前的 `messages` 和 `media`，默认 7 天；个人长期使用可按需改为 30 或 90 天。StickerPool 正在引用的 Media 受保护。Memory 中的 `sourceMessageRowIds` 只在该窗口内保证可回查原文，过期后保留为历史来源标识。删除 Media 后，再清理一小时前已经无人引用且近期没有被内容 upsert 触碰的 `media_blobs`。
- 每次清理也默认删除 30 天前的 `agent_tool_calls`、`agent_token_usage` 以及 token/tool/fetch/ingress-failure NDJSON 记录；用 `BOT_OBSERVABILITY_RETENTION_DAYS` 覆盖，设为 `0` 关闭这组观测数据清理。NDJSON 以同目录临时文件原子替换，并识别 `ts`、`time` 或 `failedAt` 时间字段；无效 JSON、无效时间戳或缺少时间字段的行会保留并记录告警。数据库表和各文件独立清理，单个目标失败不会阻塞其他目标或 Bot 启动。

## Moomoo OpenD / Mac

bot 只调用 owner 已下载并审查的官方 Skill 脚本，不负责保存账号密码或自动登录 OpenD。推荐把 Python SDK 放在独立虚拟环境，Skill 包放在仓库外的 owner 管理目录：

```bash
python3 -m venv ~/.local/share/qq-bot-v2/moomoo-venv
~/.local/share/qq-bot-v2/moomoo-venv/bin/python3 -m pip install --upgrade pip moomoo-api
mkdir -p ~/.local/share/qq-bot-v2/moomoo-skills
```

从官方页面下载 `opend-skills.zip`，解压后确认存在 `skills/moomooapi/SKILL.md`、`skills/moomooapi/scripts/check_env.py` 和 `skills/moomooapi/scripts/quote/get_snapshot.py`。在 `.env` 中配置：

```bash
MOOMOO_SKILL_ENABLED=true
MOOMOO_SKILL_DIR=/Users/your-name/.local/share/qq-bot-v2/moomoo-skills/skills/moomooapi
MOOMOO_PYTHON_BIN=/Users/your-name/.local/share/qq-bot-v2/moomoo-venv/bin/python3
MOOMOO_OPEND_PORT=11111
MOOMOO_SKILL_TIMEOUT_MS=15000
CRYPTO_PAPER_ENABLED=true
CRYPTO_PAPER_INITIAL_CASH=100000
CRYPTO_PAPER_FEE_RATE_BPS=10
```

启动并手动登录 Moomoo OpenD，保持 API 监听 `127.0.0.1:11111`。不要改成公网监听。重启 bot 后先让 agent 加载 `moomooapi` skill，再依次验证：

```text
workspace_bash: moomoo check_env
workspace_bash: moomoo quote/get_snapshot US.AAPL
```

当前开放行情及账户/订单/资金/持仓查询，以及普通证券模拟仓的 `place_order` / `modify_order` / `cancel_order`。交易写命令必须显式传 `--trd-env SIMULATE`；实盘、`--confirmed`、加密货币、组合订单和实时 push 未进入 allowlist。

`crypto_paper` 是另一条完全本地的 Crypto 模拟仓路径。它只用 Moomoo `CC.*USD` 快照定价，账户、持仓和 append-only 成交写入 PostgreSQL，不调用 Crypto 实盘接口。首次启用或 schema 更新后先运行 `pnpm db:migrate`；可以先用 `action=account` / `portfolio` 验证，除非明确需要测试成交，否则不要为了健康检查创建模拟订单。

## CloakBrowser / Mac

依据：`cloakbrowser` npm README。当前仓库依赖 `cloakbrowser@^0.4.3`、`playwright-core` 和 `mmdb-lib`。

安装和预下载：

```bash
pnpm install
pnpm exec cloakbrowser install
pnpm exec cloakbrowser info
```

默认二进制缓存目录是 `~/.cloakbrowser/`。Mac 支持 Apple Silicon 和 Intel；若自动下载失败或要回滚，可设置：

```bash
CLOAKBROWSER_CACHE_DIR=~/.cloakbrowser
CLOAKBROWSER_BINARY_PATH=/absolute/path/to/Chromium.app/Contents/MacOS/Chromium
```

bot 接入方式：

```bash
# shell 1: browser sidecar
BOT_BROWSER_ENABLED=true pnpm browser:controller

# shell 2: bot
BOT_BROWSER_ENABLED=true pnpm dev
```

常用本地配置写进 `.env`：

```bash
BOT_BROWSER_ENABLED=true
BOT_BROWSER_CONTROLLER_URL=http://127.0.0.1:37921
BOT_BROWSER_PROFILE_DIR=data/browser-profile/luna
BOT_BROWSER_ARTIFACT_DIR=data/agent-workspace/browser
BOT_BROWSER_ACTION_LOG_PATH=logs/browser-actions.ndjson
BOT_BROWSER_ACTION_TIMEOUT_MS=15000
BOT_BROWSER_ARTIFACT_MAX_FILES=50
BOT_BROWSER_ARTIFACT_MAX_AGE_MS=1209600000
BOT_BROWSER_HEADLESS=false
BOT_BROWSER_HUMANIZE=true
BOT_BROWSER_HUMAN_PRESET=default
```

需要代理时：

```bash
BOT_BROWSER_PROXY=http://user:pass@proxy.example:8080
BOT_BROWSER_GEOIP=true
BOT_BROWSER_TIMEZONE=Asia/Shanghai
BOT_BROWSER_LOCALE=zh-CN
BOT_BROWSER_ARGS=--fingerprint=12345
```

`BOT_BROWSER_GEOIP=true` 会让 CloakBrowser 通过 `mmdb-lib` 解析代理 IP 的 timezone/locale；旋转住宅代理不稳定时，优先显式配置 `BOT_BROWSER_TIMEZONE` 和 `BOT_BROWSER_LOCALE`。Pro 版 license 走 CloakBrowser 官方环境变量 `CLOAKBROWSER_LICENSE_KEY`，不要写进 repo。

## Vibe-Trading 子 Agent / Mac

Vibe-Trading 独立安装在仓库外，不把 Python 依赖和运行产物写进本仓库。上游 `zigzag` 依赖在 Python 3.12 的严格 resolver 下存在打包兼容问题；全新安装优先用 Python 3.11 + pip。当前这台机器使用的是已修复并通过 `uv pip check` 的 Python 3.12 本地 checkout，补丁说明在 `~/.local/share/vibe-trading/LOCAL_PATCH.md`。

```bash
mkdir -p ~/.local/share/vibe-trading
uv venv --seed --python 3.11 ~/.local/share/vibe-trading/.venv
~/.local/share/vibe-trading/.venv/bin/python -m pip install 'vibe-trading-ai==0.1.11'
~/.local/share/vibe-trading/.venv/bin/vibe-trading init
```

Vibe 自己的 provider、模型和数据源配置写在 `~/.vibe-trading/.env`。服务端至少保持：

```bash
# 只监听 127.0.0.1 时可留空；若设置，则 qq-bot 侧必须使用同一个值。
# API_AUTH_KEY=<独立本机随机密钥>
ENABLE_SESSION_RUNTIME=true
VIBE_TRADING_ENABLE_SHELL_TOOLS=0
VIBE_TRADING_ENABLE_SCHEDULER=0
```

启动和健康检查：

```bash
~/.local/share/vibe-trading/.venv/bin/vibe-trading serve --host 127.0.0.1 --port 8899
curl -fsS http://127.0.0.1:8899/health
```

qq-bot `.env` 使用同一个 API key，并启用 deferred capability：

```bash
VIBE_TRADING_ENABLED=true
VIBE_TRADING_BASE_URL=http://127.0.0.1:8899
# 仅当 Vibe 服务端设置了 API_AUTH_KEY 时配置：
# VIBE_TRADING_API_KEY=<同一个本机随机密钥>
VIBE_TRADING_REQUEST_TIMEOUT_MS=15000
VIBE_TRADING_TASK_TIMEOUT_MS=1800000
VIBE_TRADING_POLL_INTERVAL_MS=2000
VIBE_TRADING_RESULT_MAX_CHARS=12000
```

先直接运行一次 Vibe 的只研究任务确认 provider 可用，再重启 bot：

```bash
~/.local/share/vibe-trading/.venv/bin/vibe-trading provider doctor
~/.local/share/vibe-trading/.venv/bin/vibe-trading run -p '研究 BTC-USDT 最近 30 天趋势，只做研究，不执行真实交易' --json
```

运行时先用 `help action=describe capability=trading_research` 查看参数，再用 `invoke tool=trading_agent args={...}`。`start` / `continue` 异步返回 `taskId`、`sessionId`、`attemptId`；完成后走 `background_task get`，进程重启后走 `trading_agent result` 恢复。不要配置真实券商 connector，也不要把 Vibe API 监听到非 loopback 地址。

## 验证

- 改代码时，先跑最小 focused test；影响面大时再跑 `pnpm typecheck` 或更广测试。
- 只改文档时，检查 diff 并运行 `pnpm repo-check`。
- 修改 `prisma/schema.prisma` 后运行 `pnpm db:generate`。
- 如果不能验证，明确说明跳过了什么以及原因。
- `pnpm test` 会预加载 `scripts/test-env.mjs`，固定必需配置并让 dotenv 读取空文件，因此不会继承开发者 `.env` 中的真实群号、数据库或 LLM 配置。需要真实浏览器等 opt-in 测试时仍使用对应的显式测试开关。

## Agent 反馈

- `pnpm agent:doctor` 先做本地静态健康检查：必需文件、必需环境变量、agent 指令镜像、schema anchor、startup anchor 和 tool registry anchor；静态检查通过后连接 Postgres 执行同等只读 ledger 检查。`LLM_DEFAULT_PROVIDER=claude-code` 时还会在这里执行最多三次 persona-spoof 真实 LLM 探测，普通 Bot 启动不再探测。输出 JSON，任一阶段有错误时非零退出。
- `pnpm agent:memory-check` 只读扫描 `data/agent-workspace` 下的 Memory、Notebook、Life Journal 和 Agenda Markdown，输出文件/entry 数量、Memory lifecycle、损坏格式、跨 store 重复 ID、self/unknown supersedes 与 Agenda revision；不会创建目录、默认文件或执行修复。结构问题退出 1；可用 `pnpm agent:memory-check -- --root <path>` 指定其他 workspace。
- `pnpm agent:metrics` 汇总 `logs/token-usage.ndjson`、`logs/tool-calls.ndjson` 和当前保留的 `logs/app*.log` 到 stdout JSON：token/cache 使用、工具失败数、副作用工具数、每工具平均耗时、失败率、副作用率，以及按群 `inboxReads`、`messagesRead`、`sendAttempts`、`sendBlocked`、成功 ambient/reply 和 `readToSendRate`。默认排除 `model=mock` 测试数据，显式传 `--model mock` 时才查看；当前 token operations 包括 `agent.chat`、`agent.state_advisor`、`agent.initiative_review`、`compaction`、`life_journal.review`、`life_journal.idle_pick` 和 `memory.maintenance`。
- `pnpm agent:metrics <token-log> <tool-log> [app-log]` 可以汇总指定日志文件；省略 `app-log` 时自动读取当前 `logs/app*.log` 滚动文件。
- token/cache 使用继续 best-effort 写入 Postgres `agent_token_usage`；工具调用只有 `BOT_TOOL_AUDIT_DB_ENABLED=true` 时写入 `agent_tool_calls`。写 DB 失败只记 warning，不影响 bot 执行。
- `pnpm agent:metrics --db` 从 Postgres 汇总持久化事件；可加 `--from <iso> --to <iso> --tool <name> --operation <name> --model <name> --ok true|false --side-effect true|false` 做筛选。
- `pnpm agent:daily-metrics` 按北京时间自然日统计真实 bot 的全部模型 tool call 与 token/cache，默认查今天并排除 `model=mock` 测试数据。`--date YYYY-MM-DD` 指定截止自然日，`--days N` 逐日返回包含截止日在内的最近 N 天（最多 31 天）；例如 `pnpm agent:daily-metrics -- --date 2026-07-13` 和 `pnpm agent:daily-metrics -- --days 7`。新日志会把 `invoke` 记成其实际请求的内部工具；旧日志无法展开时保留 `invoke` 并报告 `unresolvedInvokeCalls`。该报告只在 operator/WebAdmin 面使用。
- `pnpm agent:ledger-check` 使用原始只读 Prisma 查询检查 canonical rows：验证 entry schema、严格递增 ID、runtime head、compaction chain/boundary、assistant tool call/result 原子组，以及 checkpoint 的 match/stale/corrupt 分类。它不通过 runtime repository 修复或写回数据；输出 JSON，有错误时非零退出。runtime 启动会先校验 canonical ledger，checkpoint 缺失、过期或损坏时只从 ledger 重建，绝不从消息、side-data 或日志重建 prompt history。
- `pnpm bench:ledger-commit` 不连接数据库或 provider，固定构造 1 万和 10 万 permanent entry 的合法 compacted ledger；full replay 走 canonical projection，增量路径实际调用 `LedgerCommitCoordinator` 并包含 `AgentContext` 克隆、完整 active projection 校验和 runtime state 安装。它证明日常 commit 成本取决于有界 active projection，而不是 permanent prefix；数据库事务耗时仍需结合结构化 commit 日志观察。

## Git

提交信息格式：

```text
<type>: <中文描述>
```

允许的英文 type 前缀：

```text
feat fix refactor docs test chore perf ci
```

冒号后的描述必须是中文。

## 常用日志

- `logs/tool-calls.ndjson`：脱敏后的 tool call 审计。
- token usage log path：由 `BOT_TOKEN_USAGE_LOG_PATH` 配置，默认 `logs/token-usage.ndjson`。
- browser action log path：由 browser sidecar 相关配置决定。
