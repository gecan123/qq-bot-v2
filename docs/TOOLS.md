# Agent 工具

工具注册集中在 `src/agent/tools/index.ts`。声称某个工具存在前，先查这个文件。

## 默认可见能力

- 对话控制：`pause`。
- 当前计划：`todo`（当前进程内的短期多步计划，最多一个 `in_progress`）。
- 发送：`send_message`。
- 按需工具箱：`toolbox`（`list` / `activate` / `deactivate` capability；激活成功后下一轮暴露对应 typed tool schema）。
- 知识和历史：`memory`（本地 Markdown 长期记忆库，支持 self/person/group/topic）、`skill`、`workspace_bash` 内置的 `help` / `db` / `style` 子命令。
- 知识和历史：`memory`、`inbox`（list/read 多来源消息正文）、`workspace_bash` 内置的 `help` / `db` / `style` 子命令。
- 外部内容：`workspace_bash` 内置的 `fetch` 子命令（url/image/avatar/reddit list/reddit post）、配置后可用的 `web_search`、`workspace_bash` 内置的 `openbb` 子命令。
- 文本判断：`workspace_bash` 内置的 `ai_tone` 子命令，用本地 AIRadar 模型判断中文文本更像 AI 腔调还是人味。
- 运行时工作：`background_task`（通用异步任务 list/get；get 的文本结果有通用上限）、`workspace_bash`。

## Deferred capability

- `browser`：配置 `BOT_BROWSER_ENABLED=true` 后可激活，暴露单一 action-driven `browser` 工具。
- `finance`：配置 `OPENBB_CLI_ENABLED=true` 后可激活，暴露 typed `openbb_cli`。
- `external_research`：暴露 `fetch_content`；配置 `TAVILY_API_KEY` 后同时暴露 `web_search`。
- `media_generation`：暴露 `generate_image`，创建图片生成/编辑后台任务，后续用 `background_task` 查结果。
- `media_library`：暴露 `collect_sticker`，用于表情包池 collect/list/search/random。
- `media_fetch`：暴露 `fetch_content` 的图片 URL / QQ 头像抓取能力。
- 激活状态保存在 `BotAgentSnapshot.contextSnapshot.activeToolCapabilities`，用于进程重启后恢复可见工具面；它不是 LLM 可见事实，不写入 `messages`。

## Browser

- `browser` 是单一 action-driven 工具，配置条件是 `BOT_BROWSER_ENABLED=true`，默认不常驻；先用 `toolbox action=activate capability=browser`，下一轮再调用 `browser`。
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
- `inbox` 的群读取必须显式指定监听白名单内的 groupId；私聊读取必须显式指定 peerId。其结果有行数和字符上限，并作为普通 tool result 进入 AgentContext。
- `workspace_bash` 提供可写 private workspace 和只读 repo view。repo view 必须保持 allowlist，不能读取 secrets、runtime data、logs、`node_modules`、`.git` 或私有群 prompt 文件。
- `workspace_bash` 内置 `help` 子命令用于按需查看语法；`journal write|list|search|read` 把日记和梦境存到 private workspace 文件中；`data/agent-workspace/` 下的 journal 文件是 bot 生成数据，不应提交。
- `collect_sticker` 是 deferred typed tool，不是 `workspace_bash` 子命令；它读取已有 image handle、写表情池，并影响未来可发送候选。
- `memory` 把长期记忆存到 `data/agent-workspace/memory/` 的 Markdown 文件中；这是 bot 生成数据，默认不提交。记忆文件不是 replay 来源，只有 `memory search/read/write` 的有界工具结果能进入 `AgentContext`。
- `workspace_bash` 的 tool description 保留常用 repo/db/journal/style 路由示例；复杂细节继续通过 `help <topic>` 按需披露。被拒绝的命令会返回 `help` / `try` 字段，引导下一步。
- `skill` 从 `docs/agent-skills/` 读取 curated Markdown，只能按 `skill action=list` 返回的 name 加载，并有输出上限。
- 主 system prompt 只保留身份、运行形态和能力入口；聊天硬约束在 `prompts/bot-chat-constraints.md`，风格细则在 `prompts/bot-style.md`，通过 `workspace_bash` 的 `style global constraints|base|anti_patterns|special_cases` 按需读取。
- 有副作用的工具通过 `src/ops/tool-call-log.ts` 记录。
- Bash 类能力必须保留 command allowlist、固定 workspace、最小 env、输出/时间上限和审计日志。敏感访问应通过专门脚本或 capability wrapper。
- `workspace_bash` 和 deferred tools 必须保留现有上限、preview compression、cache、timeout 和 audit 行为；legacy `workspace_bash openbb/fetch` 路由仍保留专用 wrapper，但默认说明和 prompt 应优先引导 typed deferred tools。
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
