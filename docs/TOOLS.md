# Agent 工具

工具注册集中在 `src/agent/tools/index.ts`。声称某个工具存在前，先查这个文件。

## 默认可见能力

- 对话控制：`pause`。`action=rest` 由 Agent 自己选择 30 秒到 30 分钟的休息时长，并必须提供醒来后继续事项 `intention`；计时结束会自动进入下一轮。
- 当前计划：`todo`（当前进程内的短期多步计划，最多一个 `in_progress`）。
- 发送：`send_message`。
- 按需工具箱：`toolbox`（`list` / `activate` / `deactivate` capability；激活成功后下一轮暴露对应 typed tool schema）。
- 知识和历史：`memory`（本地 Markdown 长期记忆库，支持 self/person/group/topic）、`journal`（日记/梦境）、`life_journal`（主动 Life Journal / Agenda）、`skill`、`inbox`（list/read 多来源消息正文）、`workspace_bash` 内置的 `help` / `db` / `style` 子命令。
- 表情包：`collect_sticker`（收藏、列表、搜索和随机候选）。
- 外部内容：`workspace_bash` 内置的 `fetch` 子命令（url/image/avatar/reddit list/reddit post）、配置后可用的 `web_search`、`workspace_bash` 内置的 `openbb` 子命令。
- 风格和文本判断：`chat_style` 按需读取聊天约束/风格/群定制；`ai_tone` 用本地 AIRadar 模型判断中文文本更像 AI 腔调还是人味。
- 运行时工作：`background_task`（通用异步任务 list/get；get 的文本结果有通用上限）、`workspace_bash`。

## Deferred capability

- `browser`：配置 `BOT_BROWSER_ENABLED=true` 后可激活，暴露单一 action-driven `browser` 工具。
- `finance`：配置 `OPENBB_CLI_ENABLED=true` 后可激活，暴露 typed `openbb_cli`。
- `external_research`：暴露 `fetch_content`；配置 `TAVILY_API_KEY` 后同时暴露 `web_search`。
- `media_generation`：暴露 `generate_image`，创建图片生成/编辑后台任务，后续用 `background_task` 查结果。
- `media_fetch`：暴露 `fetch_content` 的图片 URL / QQ 头像抓取能力。
- 激活状态保存在 `BotAgentSnapshot.contextSnapshot.activeToolCapabilities`，用于进程重启后恢复可见工具面；它不是 LLM 可见事实，不写入 `messages`。

## 结果契约

- 工具对 LLM 返回的事实只放在 `content`。运行时可以附带 `outcome` 和 `control`，但二者不进入 `AgentContext`；例如 `pause` 用 `control` 驱动循环休息，不反解析结果文本。
- 需要后续程序判断的结果使用稳定 JSON，并包含明确的成功状态和错误 code。面向人的摘要或错误说明放在具名字段中，不与 JSON 前后拼接自然语言。
- 外部搜索、网页、Reddit 和表情包结果按字段与条目做上限控制，并用 `truncated` 表示不完整；禁止截断完整 JSON 字符串。
- `workspace_bash` 的直接命令和 `openbb_cli` 返回命令信封，区分退出码、内容格式、正文、stderr 与截断状态。任意 stdout 只作为字符串装入信封，不因看起来像 JSON 就自动解释。
- 由 `workspace_bash` 路由到 db、style、fetch 等 typed 工具时，保留被委托工具自己的结构化结果，不额外套重复信封。

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
- `send_message` 成功不会隐式结束 Agent 当前活动；是否继续或休息由下一轮的 `pause` 决定。
- `send_message` 发送前统一走目标授权：群 reply 仅允许监听群，群 ambient 还必须属于 `BOT_GROUP_AMBIENT_SEND_IDS`，私聊目标必须是 NapCat 当前好友。未授权会明确拒绝，不会模拟成功。
- 外部工具必须有输出上限、超时和审计日志。
- `inbox` 的群读取必须显式指定监听白名单内的 groupId；私聊读取必须显式指定 peerId。read 结果用结构化 `media[].mediaId` 披露入站媒体 handle，整体仍有行数和字符上限，并作为普通 tool result 进入 AgentContext。
- `workspace_bash` 提供可写 private workspace 和只读 repo view。repo view 必须保持 allowlist，不能读取 secrets、runtime data、logs、`node_modules`、`.git` 或私有群 prompt 文件。
- `journal action=write|list|search|read` 把日记和梦境存到 private workspace 的按月 Markdown 文件中；`data/agent-workspace/` 下的 journal 文件是 bot 生成数据，不应提交。不要用 `printf` / `touch` / `mkdir` 直接维护 `journal/**` 或 `memory/**`，这些路径只能走对应高层工具写入。`workspace_bash journal ...` 作为兼容路由保留，优先使用 `journal` typed tool。
- `life_journal action=write|read_recent|read_agenda|write_agenda` 让主 agent 主动维护 `data/agent-workspace/life/` 下的 Life Journal 和 Agenda；旁路 Life Journal hook 只做每轮后的保底连续性记录，不替代主 agent 主动 journaling。`write` / `write_agenda` 是副作用操作，会进入工具审计。
- `collect_sticker` 是 always-on typed tool，不是 `workspace_bash` 子命令；`action=collect|list|search|random` 必填。它读取已有 image handle、写表情池，并返回统一的 `mediaId` / `mediaRef` 候选。
- `memory` 把长期记忆存到 `data/agent-workspace/memory/` 的 Markdown 文件中；这是 bot 生成数据，默认不提交。记忆文件不是 replay 来源，只有 `memory list/search/read/write/delete` 的有界工具结果能进入 `AgentContext`；`delete` 会永久删除明确指定的文件。
- `workspace_bash` 的 tool description 保留常用 repo/db/fetch 等路由示例；复杂细节继续通过 `help <topic>` 按需披露。被拒绝的命令会返回 `help` / `try` 字段，引导下一步。`style`、`ai_tone`、`journal` 子命令作为兼容入口保留，日常优先用同名 typed tool。
- `skill` 从 `docs/agent-skills/` 读取 curated Markdown，只能按 `skill action=list` 返回的 name 加载，并有输出上限。
- 主 system prompt 只保留身份、运行形态和能力入口；聊天硬约束在 `prompts/bot-chat-constraints.md`，风格细则在 `prompts/bot-style.md`，通过 `workspace_bash` 的 `style global constraints|base|anti_patterns|special_cases` 按需读取。
- 有副作用的工具通过 `src/ops/tool-call-log.ts` 记录。
- Bash 类能力必须保留 command allowlist、固定 workspace、最小 env、输出/时间上限和审计日志。敏感访问应通过专门脚本或 capability wrapper。
- `workspace_bash` 和 deferred tools 必须保留现有上限、preview compression、cache、timeout 和 audit 行为；`workspace_bash openbb/fetch` 路由使用专用 wrapper，默认说明和 prompt 应优先引导 typed deferred tools。
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
