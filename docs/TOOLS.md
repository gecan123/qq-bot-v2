# Agent 工具

工具注册集中在 `src/agent/tools/index.ts`。声称某个工具存在前，先查这个文件。

## 默认可见能力

- 对话控制：`pause`。`action=rest` 用于一段活动确实告一段落后的短暂休息，默认 60 秒、通常 30–120 秒，仍可自主选择最长 30 分钟。`intention` 列出 4–8 个具体可执行方向，其中至少两个能立即用现有工具开始、等待外部消息最多一个；计时结束后先实际尝试一个方向，没有尝试前不应立刻再次休息。
- 当前计划：`todo`（当前进程内的短期多步计划，最多一个 `in_progress`）。
- 发送：`send_message`（文本、图片、图文和受控音乐卡片）。
- 稳定按需壳：`help`（`list` / `describe` / `activate` / `deactivate` capability 或内部工具 schema）和 `invoke`（调用已激活 capability 内部工具）。激活不会改变下一轮顶层 tools 列表。
- 知识和历史：`memory`（本地 Markdown 长期记忆库，支持 self/person/group/topic）、`journal`（日记/梦境）、`life_journal`（主动 Life Journal / Agenda）、`skill`、`inbox`（list/read 多来源消息正文）、`workspace_bash` 内置的 `help` / `db` / `style` 子命令。
- 表情包：`collect_sticker`（收藏、移除、列表、搜索和随机候选）。
- 外部内容：`workspace_bash` 内置的 `fetch` 子命令（url/image/avatar/reddit list/reddit post）、配置后可用的 `web_search`、`workspace_bash` 内置的 `openbb` 子命令；配置官方 Moomoo Skill 后可查询行情、账户并操作普通证券模拟仓；配置 `CRYPTO_PAPER_ENABLED=true` 后，typed `crypto_paper` 使用 Moomoo Crypto 行情维护本地模拟资金、持仓和成交。
- 风格和文本判断：`chat_style` 按需读取聊天约束/风格/群定制；`ai_tone` 用本地 AIRadar 模型判断中文文本更像 AI 腔调还是人味。
- 运行时工作：`background_task`（通用异步任务 list/get；get 的文本结果有通用上限）、只读 `workspace_bash`；普通私有工作文件通过 deferred `workspace_management` 内的 `workspace_file` 修改。

## Deferred capability

- `browser`：配置 `BOT_BROWSER_ENABLED=true` 后可激活，内部工具是单一 action-driven `browser`。
- `finance`：配置 `OPENBB_CLI_ENABLED=true` 后可激活，内部工具是 `openbb_cli`。
- `website`：配置 `BOT_WEBSITE_ENABLED=true` 和独立网站仓库路径后可激活，内部工具是 `website`，用于维护 Luna 的 Astro 个人网站并发布到配置分支。
- `external_research`：内部工具包含 `fetch_content`；配置 `TAVILY_API_KEY` 后同时包含 `web_search`。
- `media_generation`：内部工具是 `generate_image`，创建图片生成/编辑后台任务，`count=1..4` 时固定最多并发 2 个图片请求，后续用 `background_task` 查结果。
- `media_inspection`：内部工具是 `inspect_media`，用入站 `mediaId` 或生成图 `ephemeralRef` 主动补跑描述，并把有界真实预览作为 image block 放入当前上下文。
- `media_fetch`：内部工具是 `fetch_content` 的图片 URL / QQ 头像抓取能力。
- `skill_management`：内部工具是 `skill_editor`，用于运行时 skill 草稿、校验和安装。
- `workspace_management`：内部工具是 `workspace_file`，用于普通私有文本工作文件的分页读取、创建、覆盖、精确替换、删除和移动。
- `document_reading`：内部工具是 `read_file`，只接受 `inbox` 返回的 `type=file` 的 `mediaId`；支持有界分页读取纯文本、PDF、DOCX、XLSX、PPTX、RTF 和 OpenDocument，不接受路径或 URL，也不执行文件内容。
- 激活状态保存在 `BotAgentSnapshot.contextSnapshot.activeToolCapabilities`，用于进程重启后恢复可调用能力；它不是 LLM 可见事实，不写入 `messages`，也不改变顶层 tools 列表。
- `invoke` 的 schema/capability resolution 是内部路由，不单独记成功 trace。已激活调用只记录一次真实目标工具结果；inactive、unknown 或壳参数失败只记录一次失败的 `invoke`，hooks 也只围绕最终执行路径运行一次。

## 结果契约

- 工具对 LLM 返回的事实只放在 `content`。运行时可以附带 `outcome` 和 `effects`，但二者不进入 `AgentContext`；例如 `pause` 返回 `effects: [{ type: 'pause' }]`，由 EffectInterpreter 驱动循环休息，不反解析结果文本。
- 需要后续程序判断的结果使用稳定 JSON，并包含明确的成功状态和错误 code。面向人的摘要或错误说明放在具名字段中，不与 JSON 前后拼接自然语言。
- schema 校验失败返回具体 `issues`、当前工具名和立即重试同一工具的提示；未知顶层工具返回当前 `availableTools` 和恢复提示，已移除的 `send_image` / `workspace_command` 分别定向引导到 `send_message.imageRef` / `workspace_bash`，不做静默兼容。
- 外部搜索、网页、Reddit 和表情包结果按字段与条目做上限控制，并用 `truncated` 表示不完整；禁止截断完整 JSON 字符串。
- `workspace_bash` 的直接命令和 `openbb_cli` 返回命令信封，区分退出码、内容格式、正文、stderr 与截断状态。任意 stdout 只作为字符串装入信封，不因看起来像 JSON 就自动解释。
- 由 `workspace_bash` 路由到 db、style、fetch 等 typed 工具时，保留被委托工具自己的结构化结果，不额外套重复信封。

## Browser

- `browser` 是单一 action-driven 内部工具，配置条件是 `BOT_BROWSER_ENABLED=true`，默认不常驻；先用 `help action=activate capability=browser`，再用 `invoke tool=browser args={...}` 调用。
- bot 进程只通过 loopback HTTP 调用 browser sidecar；sidecar 用 `pnpm browser:controller` 启动。
- sidecar 使用 CloakBrowser `launchPersistentContext()`，默认 headed、persistent profile、`humanize=true`。
- CloakBrowser 启动参数走 `.env.example` 里的 `BOT_BROWSER_*`：`HEADLESS`、`HUMANIZE`、`HUMAN_PRESET`、`PROXY`、`GEOIP`、`TIMEZONE`、`LOCALE`、`ARGS`、`EXTENSION_PATHS`。
- screenshot 返回压缩 image block 并进入 `AgentContext`；artifact 和 action log 留在磁盘，不从日志重建 replay。
- browser artifact 默认最多保留 50 个且最长 14 天；每次新增截图、下载或 annotation 后，只清理 controller-owned 的 `screenshots/`、`downloads/`、`annotations/`，配置项是 `BOT_BROWSER_ARTIFACT_MAX_FILES` / `BOT_BROWSER_ARTIFACT_MAX_AGE_MS`。清理失败记 warning，但不让当前浏览动作失败。
- 登录、2FA、账号安全、OAuth、支付、可执行/压缩包下载等高风险动作必须请求 owner help；普通浏览、cookie consent、Cloudflare/Turnstile/人机按钮可自主处理。

## Website

- 网站源码放在独立 Astro 仓库中；owner 负责首次建站、Git 认证、Vercel 项目和域名，bot 通过 `BOT_WEBSITE_REPO_DIR` 访问本机 checkout。
- `website action=status|read|write|delete|move|publish` 分别用于查看状态、读取、写入、删除、移动和发布。读取返回 revision；覆盖、删除或移动已有文件必须带最新 revision。`BOT_WEBSITE_PUBLIC_URL` 仅用于状态/发布结果提示，不参与部署鉴权。
- 读写路径只允许 `src/content/**`、`src/pages/about.astro`、`src/styles/tokens.css`、`src/styles/components.css` 和 `public/images/**` 中受支持的文件类型；绝对路径、隐藏路径、路径逃逸、符号链接和非普通文件会被拒绝。
- `publish` 只接受配置分支上的允许路径变更；先运行 `BOT_WEBSITE_CHECK_COMMAND`，再次校验工作区和暂存区，再 commit 并 push。Vercel 由网站仓库的 push 自动触发。

## 安全规则

- 对外 QQ 发言必须走 `send_message`。
- `send_message` 的 target 必须明确。不能从 memory 里推断群聊或私聊 target。
- `send_message.music` 只接受 qq/163/kugou/kuwo/migu 的歌曲 ID，或字段受限且 URL 必须为 HTTPS 的 custom 音乐卡片；不接受任意 JSON 卡片。
- assistant text 是内部历史/推理，不是公开发送通道。
- `send_message` 成功不会隐式结束 Agent 当前活动；是否继续或休息由下一轮的 `pause` 决定。
- 自主循环的 daily token budget 按“未缓存 input tokens + output tokens”计量；完整命中的 cached prefix 不重复消耗自主预算，避免长上下文高缓存命中时被误判为当天预算耗尽。
- `send_message` 发送前统一走目标授权：群 ambient 必须属于 `BOT_GROUP_AMBIENT_SEND_IDS`；不在该集合的监听群只允许 reply 持久化入站消息中通过 QQ 结构化 at 明确提到 bot 的消息，不能靠引用普通群消息绕过主动发言开关；私聊目标必须是 NapCat 当前好友。未授权会明确拒绝，不会模拟成功。
- 群 `send_message` 最终失败后才按需查询机器人自身的当前禁言状态；确认命中时 tool result 返回 `reason=group_muted` 和可用的 `mutedUntil`，否则返回 `reason=send_failed`。该事实不缓存，也不会阻止后续真实发送。
- 外部工具必须有输出上限、超时和审计日志。
- `inbox` 的群读取必须显式指定监听白名单内的 groupId；私聊读取必须显式指定 peerId。read 结果用结构化 `media[].mediaId` 披露入站媒体 handle，整体仍有行数和字符上限，并作为普通 tool result 进入 AgentContext。群文件上传 notice 会用稳定的负数 synthetic messageId 落入同一 mailbox，此时 `replyable=false`，只能 ambient 回复。
- `read_file` 位于 deferred `document_reading` capability 内，只能解析已落库的 QQ 文件 handle；单次返回和可解析输入都有上限，压缩包与旧版 DOC/XLS/PPT 明确拒绝。
- `workspace_bash` 的 workspace/repo 文件命令都只读；workspace 内置的 fetch image/avatar 等受控子命令仍可产生专用副作用。普通文件修改必须走 deferred `workspace_file`，不要开放 `printf` 重定向、`rm`、`mv` 或 `sed`。repo view 继续保持 allowlist，不能读取 secrets、runtime data、logs、`node_modules`、`.git` 或私有群 prompt 文件。
- `workspace_bash moomoo` 只路由到固定 `skills/moomooapi/scripts/**` 下的代码内 allowlist：行情及账户/订单/资金/持仓查询，以及普通证券模拟仓的下单/改单/撤单。三个交易写脚本必须显式传唯一的 `--trd-env SIMULATE`；`REAL`、`--confirmed`、加密货币、组合订单、任意 Python/脚本路径和实时订阅长进程都会被拒绝。它固定连接 loopback OpenD；详细工作流按需加载 `moomooapi` skill。
- `crypto_paper` 是独立 typed tool，只调用 Moomoo `get_snapshot.py` 获取 `CC.*USD` 买一/卖一行情，不创建 Crypto 交易 context。`buy` / `sell` 需要幂等 `clientOrderId`，资金和持仓在单个 serializable PostgreSQL transaction 中更新；`reset` 清空当前持仓并递增 generation，但保留历史订单。查询不是副作用，买卖和重置进入工具审计。
- `workspace_file action=list|read|write|replace|delete|move` 只维护普通文本工作文件。读取返回 revision，修改已有文件必须带最新 revision；拒绝 hidden/symlink/路径逃逸/二进制、重复 `data/agent-workspace` 前缀，以及 `journal/**`、`life/**`、`memory/**`、`skill-drafts/**`、`browser/**` 等 managed path。
- `journal action=write|list|search|read|update|delete|compact` 把日记和梦境存到 private workspace 的按月 Markdown 文件中。记录带稳定 ID；read 返回月文件 revision，修改要求最新 revision 并原子写回。日记只通过 `journal` typed tool 读写，不提供 `workspace_bash` 别名。
- `life_journal action=write|read_recent|read_day|read_entry|update|delete|compact|read_agenda|write_agenda` 让主 agent 主动维护 Life Journal 和 Agenda。完整 compact 前用 `read_entry` 或分页 `read_day` 获取原文；journal 和 agenda 修改都要求最新 revision。日文件使用显式 v1 格式标记和稳定 entryId；旧格式不读取，下一次写入同一天时直接以 v1 文件重建。旁路 Life Journal hook 会把当前 Agenda、最近两天 Journal 和有界本轮消息交给 reviewer，按 10 分钟节流并受超时保护；它只做保底连续性 review，不替代主 agent 主动 journaling，也不改写 `AgentContext`。review 日志用 `life_journal_review_completed` 区分 `record` / `skip`，协议连续无效则记录 `life_journal_review_invalid_skipped`。
- `collect_sticker` 是 always-on typed tool，不是 `workspace_bash` 子命令；`action=collect|list|search|random|remove` 必填。`remove` 只删除表情池记录，不删除原始 Media。
- `memory` 把长期记忆存到 `data/agent-workspace/memory/` 的 v1 Markdown 文件中。记录带稳定 entryId；`read` 支持分页并返回 revision，`update_entry` / `delete_entry` / `compact` 要求最新 revision。旧格式不参与 list/search/read，下一次写入同一目标时直接以 v1 文件重建；原有 `delete` 继续用于永久删除明确文件。
- `workspace_bash` 的 tool description 保留常用 repo/db/fetch 等路由示例；复杂细节继续通过 `help <topic>` 按需披露。被拒绝的命令会返回 `help` / `try` 字段，引导下一步。`style`、`ai_tone` 仍是受控内置入口；journal 只走 typed tool。
- `skill` 从 `docs/agent-skills/` 读取 curated Markdown，并有输出上限。已知精确 name 时可以直接 `action=load`，不知道候选时才 `action=list`；它披露不熟悉的专项规则、安全边界和标准工作流，不承担当前执行状态，后者由 `todo` 管理。目录 description 同时说明何时使用和最容易混淆的何时不要使用或替代入口。
- `skill_editor` 位于 deferred `skill_management` capability 内；只能写/删除 `data/agent-workspace/skill-drafts/*.md` 草稿和安装新的 `docs/agent-skills/*.md`。安装前必须通过校验，其中 description 必须包含正触发和负触发/替代入口；默认拒绝覆盖或删除已安装 skill。`draft` / `delete_draft` / `install` 是副作用操作。
- `website` 位于 deferred `website` capability 内；`status` / `read` 是只读操作，`write` / `delete` / `move` / `publish` 是副作用操作并进入工具审计。它不能修改依赖、构建配置、CI、Vercel 配置或网站仓库的隐藏文件。
- 主 system prompt 只保留身份、运行形态和能力入口；聊天硬约束在 `prompts/bot-chat-constraints.md`，风格细则在 `prompts/bot-style.md`，通过 `workspace_bash` 的 `style global constraints|base|anti_patterns|special_cases` 按需读取。
- 有副作用的工具通过 `src/ops/tool-call-log.ts` 记录。
- Bash 类能力必须保留 command allowlist、固定 workspace、最小 env、输出/时间上限和审计日志。敏感访问应通过专门脚本或 capability wrapper。
- `workspace_bash` 和 deferred tools 必须保留现有上限、preview compression、cache、timeout 和 audit 行为；`workspace_bash openbb/fetch` 路由使用专用 wrapper，默认说明和 prompt 应优先引导 `help` / `invoke` 稳定壳。
- 有副作用的工具要格外谨慎：`send_message`、图片生成/下载、journal/memory/sticker 工具、browser 写操作，以及未来任何会写 DB 或外部服务的工具。

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
- 新增可选配置时同步更新 `.env.example`。
- 运行 `pnpm repo-check`、`pnpm typecheck` 和相关工具的 focused tests。
