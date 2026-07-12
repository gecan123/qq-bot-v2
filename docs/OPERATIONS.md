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

### 重置 Agent 记忆（本地调试）

先停止 bot，再运行：

```bash
pnpm agent:reset-memory
```

该命令删除 `bot_agent_snapshot`、`bot_agent_goal`、旧 `memory_entries` 数据，以及 `data/agent-workspace/{memory,journal,life}`。无 snapshot 的冷启动不会回放既有消息。消息/媒体账本、表情池、浏览器 profile/artifact 和普通 workspace 文件会保留。命令可重复执行；检测到 `.bot.pid` 对应进程仍存活时会拒绝运行，避免 bot 退出时重新保存旧 snapshot。

```bash
pnpm dev
pnpm dev:once
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm repo-check
pnpm agent:doctor
pnpm agent:metrics
pnpm agent:snapshot-check
pnpm db:generate
pnpm db:migrate
pnpm db:push
pnpm tick
pnpm browser:controller
pnpm toollog
pnpm toollogf
```

## 本地运行

`LLM_FALLBACK_MODEL` 默认不配置。需要时填写与 `LLM_DEFAULT_MODEL` 使用同一 `LLM_DEFAULT_PROVIDER` wire path 的模型；它只接管 overload/5xx，不用于鉴权、限流、参数错误或 context overflow。

- 从仓库根目录启动，确保 `.bot.pid`、logs、prompts 和相对路径稳定。
- `pnpm dev` 使用 watch 模式，文件变化会重启；`pnpm dev:once` 单次启动，不监听文件变化。
- `pnpm tick` 会读取 `.bot.pid`，向进程发送 `SIGUSR1`，并注入一个仅供人工调试的 curiosity tick。正常自主循环由 Agent 的 `pause` 计时和 BotLoop 连续运行驱动，不依赖这个命令。

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

self Goal 默认 1,000,000 tokens，允许自行指定到 10,000,000；滚动 24 小时最多 64 个、相邻创建至少 60 秒。两项限制只用于阻止失控循环，不是日常行为准入。Agent 用 `abandon_self` 放弃自己的 Goal 时必须保留理由；该动作不能作用于 owner Goal。

## Owner 审批

开发默认是 `BOT_APPROVAL_MODE=thin`：只审批网站 `publish` 和未列入 MCP `readOnlyTools` 的调用。本地 memory/journal/Life Journal/workspace 删除、网站本地删除和 skill 安装直接执行，不再打断迭代。`strict` 恢复这些本地审批，`off` 关闭统一审批 hook；三种模式都不会改变工具自身的 revision、路径、target、schema、allowlist 和 timeout 边界。

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

重启后先通过 `help action=activate capability=mcp_connectors` 激活，再按以下顺序使用：

```text
invoke tool=mcp args={"action":"servers"}
invoke tool=mcp args={"action":"tools","server":"example"}
invoke tool=mcp args={"action":"call","tool":"mcp__example__search","arguments":{"query":"..."}}
```

`servers` 不启动子进程；第一次 `tools` / `connect` / `call` 才连接。`tools` 默认每页 5 项，返回 `nextOffset` 时继续分页。schema 快照带 `schemaVersion` 哈希；它是调试和变更审计依据，不是 replay 数据源。当前不支持 Streamable HTTP、resources、prompts 或远端自动安装。
- logs 写在 `logs/` 下，是运维证据，不是 replay 输入。
- 仓库对外展示的机器可读时间统一为北京时间 `YYYY-MM-DDTHH:mm:ss.SSS+08:00`；PostgreSQL `timestamptz` 仍保存绝对时刻。
- 启动时当前 system prompt 会写入 `logs/system-prompt.txt`，便于检查。
- 启动恢复会先连接 NapCat，并等待首次群历史 backfill 的所有来源尝试完成，再执行 missed-message replay；单群补拉失败记录 source-level error，其余来源和 replay 继续。
- `SIGINT` / `SIGTERM` 会触发幂等 graceful shutdown：停止 ingress 和 Agent、等待当前 round、drain backfill、停止 jobs、保存最终 snapshot，最后断开数据库。单阶段超时或失败会记录 `shutdown_phase_failed`，并继续后续清理。

## 数据保留

- 后台任务状态默认原子写入 `data/agent-workspace/runtime/background-tasks.json`，可用 `BOT_BACKGROUND_TASK_STATE_PATH` 改路径。重启时普通 running 会变成 `interrupted` 并通知 Agent；`schedule` 任务带稳定 recovery descriptor，会按原 deadline 重新挂载。
- 图片任务的 metadata/预览可随 registry 保留，但 `ephemeralRef` 属于进程内 OutboundCache；重启后结果会明确标记失效，需重新生成，不能假装原图仍可发送。
- MCP schema 快照默认位于 `data/agent-workspace/runtime/mcp-schemas/*.json`；每次成功 discovery 原子覆盖当前版本。这里不保存远端调用结果或认证密钥。

- 启动时清理 7 天前的 `messages` 和 `media`；StickerPool 正在引用的媒体受保护，不会随普通媒体清理删除。
- `agent_tool_calls`、`agent_token_usage` 和 NDJSON 日志目前没有自动 retention。生产部署应通过数据库/日志平台设置保留周期；仓库侧统一策略仍记录在 `docs/TECH_DEBT.md`。

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
VIBE_TRADING_MODEL=gpt-5.5
# 可选；仅在当前中继与模型已验证支持时设置：low / medium / high / xhigh
VIBE_TRADING_REASONING_EFFORT=
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

运行时先用 `help action=activate capability=trading_research`，再用 `invoke tool=trading_agent args={...}`。`start` / `continue` 异步返回 `taskId`、`sessionId`、`attemptId`；完成后走 `background_task get`，进程重启后走 `trading_agent result` 恢复。不要配置真实券商 connector，也不要把 Vibe API 监听到非 loopback 地址。

## 验证

- 改代码时，先跑最小 focused test；影响面大时再跑 `pnpm typecheck` 或更广测试。
- 只改文档时，检查 diff 并运行 `pnpm repo-check`。
- 修改 `prisma/schema.prisma` 后运行 `pnpm db:generate`。
- 如果不能验证，明确说明跳过了什么以及原因。
- `pnpm test` 会预加载 `scripts/test-env.mjs`，固定必需配置并让 dotenv 读取空文件，因此不会继承开发者 `.env` 中的真实群号、数据库或 LLM 配置。需要真实浏览器等 opt-in 测试时仍使用对应的显式测试开关。

## Agent 反馈

- `pnpm agent:doctor` 做本地、无网络健康检查：必需文件、必需环境变量、agent 指令镜像、schema anchor、startup anchor 和 tool registry anchor。输出 JSON，有错误时非零退出。
- `pnpm agent:metrics` 汇总 `logs/token-usage.ndjson`、`logs/tool-calls.ndjson` 和当前保留的 `logs/app*.log` 到 stdout JSON：token/cache 使用、工具失败数、副作用工具数、每工具平均耗时、失败率、副作用率，以及按群 `inboxReads`、`messagesRead`、`sendAttempts`、`sendBlocked`、成功 ambient/reply 和 `readToSendRate`。当前 token operations 包括 `agent.chat`、`compaction` 和 `life_journal.review`。
- `pnpm agent:metrics <token-log> <tool-log> [app-log]` 可以汇总指定日志文件；省略 `app-log` 时自动读取当前 `logs/app*.log` 滚动文件。
- token/cache 使用继续 best-effort 写入 Postgres `agent_token_usage`；工具调用只有 `BOT_TOOL_AUDIT_DB_ENABLED=true` 时写入 `agent_tool_calls`。写 DB 失败只记 warning，不影响 bot 执行。
- `pnpm agent:metrics --db` 从 Postgres 汇总持久化事件；可加 `--from <iso> --to <iso> --tool <name> --operation <name> --model <name> --ok true|false --side-effect true|false` 做筛选。
- `pnpm agent:snapshot-check` 只读检查 `bot_agent_snapshot`：验证 snapshot JSON 可序列化、assistant tool call 与 tool result 相邻匹配、JSON-like tool result 可解析、`activeToolCapabilities` 未混入 messages、mailbox cursor 与 continuity 元数据合法；输出 JSON，有错误时非零退出。

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
