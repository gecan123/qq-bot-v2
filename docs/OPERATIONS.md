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
pnpm db:generate
pnpm db:migrate
pnpm db:push
pnpm tick
pnpm browser:controller
pnpm toollog
pnpm toollogf
```

## 本地运行

- 从仓库根目录启动，确保 `.bot.pid`、logs、prompts 和相对路径稳定。
- `pnpm dev` 使用 watch 模式，文件变化会重启；`pnpm dev:once` 单次启动，不监听文件变化。
- `pnpm tick` 会读取 `.bot.pid`，向进程发送 `SIGUSR1`，并注入一个 curiosity tick。
- logs 写在 `logs/` 下，是运维证据，不是 replay 输入。
- 启动时当前 system prompt 会写入 `logs/system-prompt.txt`，便于检查。

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

## 验证

- 改代码时，先跑最小 focused test；影响面大时再跑 `pnpm typecheck` 或更广测试。
- 只改文档时，检查 diff 并运行 `pnpm repo-check`。
- 修改 `prisma/schema.prisma` 后运行 `pnpm db:generate`。
- 如果不能验证，明确说明跳过了什么以及原因。

## Agent 反馈

- `pnpm agent:doctor` 做本地、无网络健康检查：必需文件、必需环境变量、agent 指令镜像、schema anchor、startup anchor 和 tool registry anchor。输出 JSON，有错误时非零退出。
- `pnpm agent:metrics` 汇总 `logs/token-usage.ndjson` 和 `logs/tool-calls.ndjson` 到 stdout JSON：token/cache 使用、工具失败数、副作用工具数、每工具平均耗时、失败率、副作用率和 malformed log line 计数。
- `pnpm agent:metrics <token-log> <tool-log>` 可以汇总指定日志文件。
- 运行时会把工具调用和 token/cache 使用 best-effort 写入 Postgres 的 `agent_tool_calls` / `agent_token_usage`，写 DB 失败只记 warning，不影响 bot 执行。
- `pnpm agent:metrics --db` 从 Postgres 汇总持久化事件；可加 `--from <iso> --to <iso> --tool <name> --operation <name> --model <name> --ok true|false --side-effect true|false` 做筛选。

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
