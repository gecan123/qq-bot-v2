# Agent 工具

工具注册集中在 `src/agent/tools/index.ts`。声称某个工具存在前，先查这个文件。

## 已注册能力

- 对话控制：`pause`。
- 发送：`send_message`。
- 知识和历史：`memory`、`workspace_bash` 内置的 `help` / `db` / `style` 子命令。
- 外部内容：`workspace_bash` 内置的 `fetch` 子命令（url/image/avatar/reddit list/reddit post）、配置后可用的 `web_search`、`workspace_bash` 内置的 `openbb` 子命令。
- 文本判断：`workspace_bash` 内置的 `ai_tone` 子命令，用本地 AIRadar 模型判断中文文本更像 AI 腔调还是人味。
- 媒体生成和复用：`generate_image`（创建图片生成/编辑后台任务，quality、批量输出、最多 5 张输入图）、`collect_sticker`（collect/list/search/random）。
- 运行时工作：`background_task`（通用异步任务 list/get）、`workspace_bash`、配置后可用的 `browser`。

## Browser

- `browser` 是单一 action-driven 工具，注册条件是 `BOT_BROWSER_ENABLED=true`。
- bot 进程只通过 loopback HTTP 调用 browser sidecar；sidecar 用 `pnpm browser:controller` 启动。
- sidecar 使用 CloakBrowser `launchPersistentContext()`，默认 headed、persistent profile、`humanize=true`。
- CloakBrowser 启动参数走 `.env.example` 里的 `BOT_BROWSER_*`：`HEADLESS`、`HUMANIZE`、`HUMAN_PRESET`、`PROXY`、`GEOIP`、`TIMEZONE`、`LOCALE`、`ARGS`、`EXTENSION_PATHS`。
- screenshot 返回压缩 image block 并进入 `AgentContext`；artifact 和 action log 留在磁盘，不从日志重建 replay。
- 登录、2FA、账号安全、OAuth、支付、可执行/压缩包下载等高风险动作必须请求 owner help；普通浏览、cookie consent、Cloudflare/Turnstile/人机按钮可自主处理。

## 安全规则

- 对外 QQ 发言必须走 `send_message`。
- `send_message` 的 target 必须明确。不能从 memory 里推断群聊或私聊 target。
- assistant text 是内部历史/推理，不是公开发送通道。
- group ambient 发送受 ingress allowlist 和 `BOT_GROUP_AMBIENT_SEND_IDS` 保护。reply 和 private 不受 ambient whitelist 控制。
- 外部工具必须有输出上限、超时和审计日志。
- `workspace_bash` 提供可写 private workspace 和只读 repo view。repo view 必须保持 allowlist，不能读取 secrets、runtime data、logs、`node_modules`、`.git` 或私有群 prompt 文件。
- `workspace_bash` 内置 `help` 子命令用于按需查看语法；`journal write|list|search|read` 把日记和梦境存到 private workspace 文件中；`data/agent-workspace/` 下的 journal 文件是 bot 生成数据，不应提交。
- 有副作用的工具通过 `src/ops/tool-call-log.ts` 记录。
- Bash 类能力必须保留 command allowlist、固定 workspace、最小 env、输出/时间上限和审计日志。敏感访问应通过专门脚本或 capability wrapper。
- `workspace_bash` 和 `browser` 必须保留现有上限、preview compression、cache、timeout 和 audit 行为；其中 `workspace_bash` 内置的 `db` / `style` / `openbb` / `fetch` / `ai_tone` 子命令仍走对应专用 wrapper。
- 有副作用的工具要格外谨慎：`send_message`、图片生成/下载、`workspace_bash` journal 子命令、memory/sticker 工具、browser 写操作，以及未来任何会写 DB 或外部服务的工具。

## LLM 路径

- Agent chat 有 Claude-Code-compatible 和 OpenAI-agent 两条路径。除非任务明确要求，否则不要改 wire format、cache-control 或 provider identity 细节。
- 媒体描述使用 `src/llm/**` 下的 routing provider，和 agent chat client 分离。
- 优先使用渐进式披露：system prompt 只放稳定边界和入口，长手册和可变数据放到工具或文件后面。
- 不要写锁定 prompt 具体措辞的单元测试。应测试 parser、schema 和工具契约。

## 修改清单

修改工具注册或行为时：

- 更新工具实现和测试。
- 检查 `src/agent/bot-system-prompt.ts` 里的 progressive-disclosure index。
- 如果能力面变化，同步更新本文档。
- 运行 `pnpm repo-check`、`pnpm typecheck` 和相关工具的 focused tests。
