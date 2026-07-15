# Agent 工具

工具注册集中在 `src/agent/tools/index.ts`。声称某个工具存在前，先查这个文件。

## 默认可见能力

- 对话控制：`pause`。`action=rest` 是确实想暂时停一下时的短休息安全阀，默认 60 秒、范围 30–600 秒。首次请求必须使用 `confirmed=false`；Life Journal idle picker 优先从最近 durable context 找具体锚点，再以 Agenda、近期 Journal 或 `notes/wishes.md` 为后备，默认硬超时 30 秒，可用 `BOT_LIFE_JOURNAL_IDLE_PICK_TIMEOUT_MS` 调整。完整候选以 `alternative_available.idleThought` 进入 ledger 且不暂停；它是可接受或放过的自主念头，不是 runtime 任务。只有 picker 成功返回无念头时首次请求才直接休息；超时、provider 错误或不完整结果返回 `alternative_check_unavailable` 且不暂停。只有 `alternative_available` 仍是 ledger 中最近的已完成工具结果时，`confirmed=true` 才有效；提前确认或中间已做过别的动作都会返回 `confirmation_required`，重新检查后才能休息。结构化 `intention` 只写一个 `primaryDirection` 和一个不同的 `alternativeDirection`，都要包含对象与第一步。等消息、机械检查行情、泛泛浏览站点或整理 memory/journal 不是行动方向；未来某时再看用 `schedule`。真正休息结束后结果回显 `resumePlan`，下一轮先完成一个具体动作再决定是否再次休息；若被高优事件打断，处理完后再回看同一 plan。
- 短期调度：`schedule action=create|list|cancel`，公开 ID 字段统一为 `id`。`create` 支持一次性 `at`、固定间隔 `every` 和墙上时间 `cron`；一次触发必须位于 30 秒到 3 天内，周期相邻触发至少 5 分钟，最多 20 个 active job，每个 job 创建 3 天后过期。同名同定义创建幂等返回 `existing`，同名不同定义返回冲突及已有 `id`，需先 cancel；`list` 返回有界公开摘要。状态保存在独立 schedule store，重启后恢复 timer；到期只注入 `scheduled_wake` 注意事件，不执行预存命令。它在轮次边界低于 `priority=high` QQ 通知、高于 active Goal 和普通环境事件；普通短休息仍用 `pause`。
- 当前计划：`todo`（当前进程内的短期多步计划，最多一个 `in_progress`）。
- 持久目标：`goal action=get|create_self|complete|report_blocker|abandon_self`。没有未完成 Goal 时，Agent 可以为自己的兴趣直接创建 `origin=self` 的持久目标，必须给出真实 `motivation` 和可核验 `completionCriteria`；默认预算 1,000,000 tokens，单个上限 10,000,000，60 秒冷却和滚动 24 小时最多 64 个只是失控保险丝。Agent 可以放弃 self Goal，但不能放弃 owner Goal。配置的 owner 仍可用私聊 `/goal` 创建、暂停、恢复或取消，owner Goal 会直接抢占 self Goal。轮次边界优先级是 `priority=high` QQ 通知 > `scheduled_wake` > active Goal > 普通环境事件；前台仍是单一串行 BotLoop，等待后台或外部输入时可以做其他事情。`complete` 必须提交逐项真实证据；同一 blocker 每个连续 Goal round 用相同 `blockerKey` 报告，第三轮才转 `blocked`。Goal token budget 按未缓存 input 加 output 计量；只有明确的 provider 硬额度/账单上限才转 `usage_limited`，普通临时 429 仍走已有有界重试和 round backoff。
- QQ 目录：`qq_directory`（分页列出/搜索 NapCat 当前全部好友；群目录只披露当前已加入且位于 `BOT_TARGET_GROUP_IDS` 的群）。
- 稳定按需壳：`help`（`list` / `describe` / `activate` / `deactivate` capability 或内部工具 schema）和 `invoke`（调用已激活 capability 内部工具）。激活不会改变下一轮顶层 tools 列表。
- 知识和历史：`memory`（稳定长期记忆）、`notebook`（按稳定 topic 维护研究/阅读/市场/项目过程）、`life_journal`（经历、感受、梦和 Agenda）、`skill`、`inbox`（list/read 多来源消息正文）、`workspace_bash` 内置的 `help` / `db` / `style` / `metrics` 子命令。`metrics` 按北京时间自然日返回真实 bot 的工具调用、token/cache 和 rest 行为，包括 idle anchor 来源与转向后是否实际行动，并默认排除 `model=mock` 测试数据。
- 表情包：`collect_sticker`（收藏、移除、列表、搜索和随机候选）。
- 外部内容：`workspace_bash` 内置的 `fetch` 子命令（url/image/avatar/reddit list/reddit post）、配置后可用的 `web_search`、`workspace_bash` 内置的 `openbb` 子命令；配置官方 Moomoo Skill 后可查询行情、账户并操作普通证券模拟仓；配置 `CRYPTO_PAPER_ENABLED=true` 后，typed `crypto_paper` 使用 Moomoo Crypto 行情维护本地模拟资金、持仓和成交。
- 风格和文本判断：`chat_style` 按需读取聊天约束/风格/群定制；`ai_tone` 用本地 AIRadar 模型判断中文文本更像 AI 腔调还是人味。
- 运行时工作：`background_task`（通用异步任务 list/get；get 的文本结果有通用上限）、只读 `workspace_bash`；普通私有工作文件通过 deferred `workspace_management` 内的 `workspace_file` 修改。任务 registry 持久化到 `BOT_BACKGROUND_TASK_STATE_PATH`；无 recovery descriptor 的旧 running 在重启时明确变成 `interrupted`，不会永远伪装成运行中。定时唤醒不走 task registry，而由上述独立 schedule store 恢复。
- 受限委派：`delegate` 把边界明确的调查/分析任务放进最多 2 并发的后台 lane。每个 delegate 使用全新 AgentContext，只看 task 文本；`allowedTools` 只能从 `workspace_bash`、`inbox`、`qq_directory`、`chat_style`、`ai_tone`、`skill`、`background_task` 的固定只读集合选，默认纯 LLM。轮数最多 8、超时最多 300 秒，必须用 `delegate_return` 结构化结束；内部 transcript 不进入主 ledger，最终结果通过 `background_task get` 取回。
- 审批控制：`approval action=list|status|approve|cancel`。默认 `BOT_APPROVAL_MODE=thin`，只拦网站 `publish` 和未声明只读的 MCP 调用；本地 memory/notebook/Life Journal/workspace 删除、网站本地删除和 skill 安装不等待审批。被拦调用会返回 `approvalId`；owner 私聊发送精确文本 `批准 <approvalId>` 后，用消息 `rowId` 批准并以相同参数重试。审批默认 10 分钟过期且只能消费一次。需要旧的全量本地审批时设 `strict`，快速实验可设 `off`。

## Deferred capability

- `qq`：内部工具是 `qq_conversation` 和 `send_message`。先 `help action=activate capability=qq`，再用 `invoke` 调 `qq_conversation action=open` 显式打开监听群或当前好友；后续 `send_message` 只接受 `message`、`imageRef`、`music`、可选 `reply_to` 和群聊可选 `mention_user_id`，不接受 `target` 或 `mode`。省略 `reply_to` 为 ambient，有值为 reply；`CHAT_CONTEXT_UNAVAILABLE` / `CHAT_CONTEXT_STALE` 时必须重新打开预期会话。
- `mcp_connectors`：仅在配置 `BOT_MCP_CONFIG_PATH` 后出现，内部工具是 `mcp`。启动只读取配置，不拉外部进程；`mcp action=tools|connect|call` 首次使用才启动对应 stdio server。先分页读取 tools，再用返回的 `mcp__server__tool` 完整名称调用。schema 快照写入 `BOT_MCP_SCHEMA_SNAPSHOT_DIR`，远端结果和二进制内容有上限，关机时主动断开。
- `browser`：配置 `BOT_BROWSER_ENABLED=true` 后可激活，内部工具是单一 action-driven `browser`；截图、下载和 annotation 返回后，artifact retention 清理由 sidecar 的单 worker 合并执行。
- `finance`：配置 `OPENBB_CLI_ENABLED=true` 后可激活，内部工具是 `openbb_cli`。
- `trading_research`：配置 `VIBE_TRADING_ENABLED=true` 后可激活，内部工具是 `trading_agent`；已有具体金融问题且需要跨来源证据、可复现策略规则、反证或历史回测时，委派给本机 Vibe-Trading Agent，而不是把它的全部 MCP 工具展开到主 Agent。简单报价或单项数据仍用 `finance` / `openbb_cli`，不要为机械盯行情启动子 Agent。
- `website`：配置 `BOT_WEBSITE_ENABLED=true` 和独立网站仓库路径后可激活，内部工具是 `website`，用于维护 Luna 的 Astro 个人网站并发布到配置分支。
- `external_research`：内部 `fetch_content` 只暴露普通网页和 Reddit action；配置 `TAVILY_API_KEY` 后同时包含 `web_search`。
- `fetch_content action=url` 默认同步返回网页摘要；预计较慢或想同时处理其他事情时可传 `background=true`，它进入最多 3 并发的 `network` lane，立即返回 `taskId`，完成后通过 `background_task` 取结果。
- `media_generation`：内部工具是 `generate_image`，创建图片生成/编辑后台任务，`count=1..4` 时固定最多并发 2 个图片请求，后续用 `background_task` 查结果。
- `media_inspection`：内部工具是 `inspect_media`，用入站 `mediaId` 或生成图 `ephemeralRef` 返回有界真实预览 image block；缺失的入站图片描述进入 `media-description` lane，当前结果标记 `descriptionStatus=pending` 而不等待模型。
- `media_fetch`：内部 `fetch_content` 只暴露图片 URL / QQ 头像 action；激活它不会放开普通网页或 Reddit 抓取。
- `skill_management`：内部工具是 `skill_editor`；同类多步规则反复出现、现有 skill 未覆盖且能写清使用与排除边界时，用它创建、校验和安装运行时 skill。一次性任务、临时笔记和当前执行状态不要做成 skill。
- `workspace_management`：内部工具是 `workspace_file`，用于普通私有文本工作文件的分页读取、创建、覆盖、精确替换、删除和移动。
- `document_reading`：内部工具是 `read_file`，只接受 `inbox` 返回的 `type=file` 的 `mediaId`；支持有界分页读取纯文本、PDF、DOCX、XLSX、PPTX、RTF 和 OpenDocument，不接受路径或 URL，也不执行文件内容。
- 激活状态保存在 `BotAgentSnapshot.contextSnapshot.activeToolCapabilities`，QQ 当前会话保存在同一 snapshot 的 `qqConversationFocus`；两者用于进程重启后恢复运行控制状态，不是 LLM 可见事实，不写入 `messages`，也不改变顶层 tools 列表。
- `invoke` 的 schema/capability resolution 是内部路由，不单独记成功 trace。对外 schema 仍要求 `args` 是对象；若 provider 误传了可解析为 JSON 对象的字符串，runtime 会在 schema 校验前归一化，其他字符串、数组和空参数仍按目标 schema 拒绝。已激活调用只记录一次真实目标工具结果；inactive 返回按 action 缩小后的 capability 和结构化激活/重试序列；unknown 或壳参数失败只记录一次失败的 `invoke`，hooks 也只围绕最终执行路径运行一次。

## 结果契约

- 工具对 LLM 返回的事实只放在 `content`。运行时可以附带 `outcome` 和 `effects`，但二者不进入 `AgentContext`；例如真正开始的 `pause` 返回 `effects: [{ type: 'pause' }]`，由 EffectInterpreter 驱动循环休息，不反解析结果文本。`alternative_available` 没有 pause effect，因此 Agent 会在同一活动里继续选择动作。
- 需要后续程序判断的结果使用稳定 JSON，并包含明确的成功状态和错误 code。面向人的摘要或错误说明放在具名字段中，不与 JSON 前后拼接自然语言。
- schema 校验失败返回具体 `issues`、当前工具名和立即重试同一工具的提示；未知顶层工具返回当前 `availableTools` 和恢复提示，已移除的 `send_image` / `workspace_command` 分别定向引导到 `send_message.imageRef` / `workspace_bash`，不做静默兼容。
- `capability_inactive` / `invalid_arguments` 这类可恢复失败在命中连续轮次上限时，Runtime Host 最多保留 3 个立即纠错轮；纯 `help` 步骤可继续该有界链路，成功重试或额度用完后仍进入原 cooldown。该运行时状态不进入 ledger 或 snapshot。
- 外部搜索、网页、Reddit 和表情包结果按字段与条目做上限控制，并用 `truncated` 表示不完整；禁止截断完整 JSON 字符串。
- `workspace_bash` 的直接命令和 `openbb_cli` 返回命令信封，区分退出码、内容格式、正文、stderr 与截断状态。任意 stdout 只作为字符串装入信封，不因看起来像 JSON 就自动解释。
- 由 `workspace_bash` 路由到 db、style、fetch 等 typed 工具时，保留被委托工具自己的结构化结果，不额外套重复信封。
- `trading_agent action=start|continue` 返回本地 `taskId` 和 Vibe 的 `sessionId` / `attemptId`。正常完成后用 `background_task action=get` 读取有界结果；qq-bot 重启导致内存 task 丢失时，凭 `sessionId` 调 `status` / `result` 直接从 Vibe 的持久 session 恢复，不从日志重建。

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

- 对外 QQ 发言必须激活 `qq`，先通过 `qq_conversation open` 明确当前群聊或私聊，再通过 `invoke` 调用 `send_message`。不能从 memory、消息文本或日志推断 target，也不能假设新 mailbox 会自动切换当前会话。
- `send_message.music` 只接受 qq/163/kugou/kuwo/migu 的歌曲 ID，或字段受限且 URL 必须为 HTTPS 的 custom 音乐卡片；不接受任意 JSON 卡片。
- assistant text 是内部历史/推理，不是公开发送通道。
- `send_message` 成功不会隐式结束 Agent 当前活动；是否继续或休息由下一轮的 `pause` 决定。
- `send_message` 发送前统一走目标授权：群 ambient 必须属于 `BOT_GROUP_AMBIENT_SEND_IDS`；不在该集合的监听群只允许 reply 持久化入站消息中通过 QQ 结构化 at 明确提到 bot 的消息，不能靠引用普通群消息绕过主动发言开关；私聊目标必须是 NapCat 当前好友。未授权会明确拒绝，不会模拟成功。
- `qq_directory` 是只读目录。`list_friends` / `search_friends` 覆盖 NapCat 当前全部好友，因此这些结果都可作为 `qq_conversation open` 的 private target；`list_groups` 只返回 NapCat 当前群列表与 `BOT_TARGET_GROUP_IDS` 的交集，不扩大群监听或发送授权。结果有条数上限和 offset 分页，不提供加删好友、加退群或群管理动作。
- 群 `send_message` 最终失败后才按需查询机器人自身的当前禁言状态；确认命中时 tool result 返回 `reason=group_muted` 和可用的 `mutedUntil`，否则返回 `reason=send_failed`。该事实不缓存，也不会阻止后续真实发送。
- 外部工具必须保留输出上限和超时；审计强度由 `BOT_TOOL_AUDIT_MODE` 控制，开发默认只记副作用。
- 默认 thin 审批只保护公开发布和未知 MCP 写操作，不阻塞本地内容快速迭代。`strict` 才额外审批 memory/notebook/Life Journal/workspace 删除、网站本地删除和 skill 安装；`off` 关闭统一 approval hook，但不会关闭 target、revision、路径、schema、超时和 allowlist 等工具自身边界。
- MCP 配置是 operator 权限面，不由 Agent 修改。`readOnlyTools` 必须逐个写远端原始 tool name；远端 `readOnlyHint` 只作为展示信息，不能自动获得信任。未列出的工具即使自称只读，也默认审批。
- `inbox` 的群读取必须显式指定监听白名单内的 groupId；私聊读取必须显式指定 peerId。read 结果用结构化 `media[].mediaId` 披露入站媒体 handle，整体仍有行数和字符上限，并作为普通 tool result 进入 AgentContext。群文件上传 notice 会用稳定的负数 synthetic messageId 落入同一 mailbox，此时 `replyable=false`，发送时必须省略 `reply_to`。
- `read_file` 位于 deferred `document_reading` capability 内，只能解析已落库的 QQ 文件 handle；单次返回和可解析输入都有上限，压缩包与旧版 DOC/XLS/PPT 明确拒绝。
- `workspace_bash` 的 workspace/repo 文件命令都只读；workspace 内置的 fetch image/avatar 等受控子命令仍可产生专用副作用。普通文件修改必须走 deferred `workspace_file`，不要开放 `printf` 重定向、`rm`、`mv` 或 `sed`。repo view 继续保持 allowlist，不能读取 secrets、runtime data、logs、`node_modules`、`.git` 或私有群 prompt 文件。
- `workspace_bash moomoo` 只路由到固定 `skills/moomooapi/scripts/**` 下的代码内 allowlist：行情及账户/订单/资金/持仓查询，以及普通证券模拟仓的下单/改单/撤单。三个交易写脚本必须显式传唯一的 `--trd-env SIMULATE`；`REAL`、`--confirmed`、加密货币、组合订单、任意 Python/脚本路径和实时订阅长进程都会被拒绝。它固定连接 loopback OpenD；详细工作流按需加载 `moomooapi` skill。
- `crypto_paper` 是独立 typed tool，只调用 Moomoo `get_snapshot.py` 获取 `CC.*USD` 买一/卖一行情，不创建 Crypto 交易 context。`buy` / `sell` 需要幂等 `clientOrderId`，资金和持仓在单个 serializable PostgreSQL transaction 中更新；`reset` 清空当前持仓并递增 generation，但保留历史订单。查询不是副作用，买卖和重置进入工具审计。
- `trading_agent` 只连接配置的 loopback HTTP origin，拒绝远端 URL、URL 路径、凭据内嵌和重定向；请求、后台任务和结果都有超时/字符上限。发送给 Vibe 的每个 prompt 都附加固定的研究边界，禁止真实下单、撤单、券商授权、资金划转、定时任务和对外消息。`start` / `continue` / `cancel` 作为副作用审计，`status` / `result` 只读。
- `workspace_file action=list|read|write|replace|delete|move` 只维护普通文本工作文件。读取返回 revision，修改已有文件必须带最新 revision；拒绝 hidden/symlink/路径逃逸/二进制、重复 `data/agent-workspace` 前缀，以及 `notebook/**`、`life/**`、`memory/**`、`skill-drafts/**`、`browser/**` 等 managed path；旧 `journal/**` 也继续保留为受管路径，避免普通文件工具误改历史数据。
- `notebook action=write|list|search|read|update|delete|compact` 把研究、阅读、市场观察、项目过程和其他主题笔记存到 `notebook/<kind>/YYYY-MM.md`。每条记录必须有稳定单行 topic 和稳定 ID；list/search 可按 kind/topic 过滤，read 返回月文件 revision，修改要求最新 revision 并原子写回。compact 只允许同 kind、同月、同 topic 的记录。过程信息写 Notebook，稳定结论写 memory，经历、感受和梦写 Life Journal。
- `life_journal action=write|read_recent|read_day|read_entry|update|delete|compact|read_agenda|write_agenda` 让主 agent 主动维护 Life Journal 和 Agenda。write 的 `kind=reflection|dream` 区分主观回顾与梦境，默认 reflection；承诺、未完兴趣、等待事项和具体下一步只放 Agenda。完整 compact 前用 `read_entry` 或分页 `read_day` 获取原文；Journal 和 Agenda 修改都要求最新 revision。日文件使用包含 kind 的显式 v2 格式标记和稳定 entryId；旧格式不读取，下一次写入同一天时直接以 v2 文件重建。旁路 Life Journal hook 只把有界本轮快照放进共享 scheduler 的单 worker `maintenance` lane，主循环不等待 review；忙时只保留最新 pending 任务，并用关闭 thinking 的专用 client 读取当前 Agenda、最近两天 Journal 后决策。review 按 10 分钟节流，超时会真正取消底层请求并以 `life_journal_review_timed_out_skipped` 安全跳过。它只做保底连续性 review，不替代主 agent 主动 journaling，也不改写 `AgentContext`。所有 `life/**` writer 与其他长期状态 writer 共用按资源键的单进程协调器，Agenda review 还带读取时 revision 做 CAS；冲突时跳过而不覆盖。成功日志用 `life_journal_review_completed` 区分 `record` / `skip`，协议连续无效则记录 `life_journal_review_invalid_skipped`。
- `collect_sticker` 是 always-on typed tool，不是 `workspace_bash` 子命令；`action=collect|list|search|random|remove` 必填。`remove` 只删除表情池记录，不删除原始 Media。
- `memory` 把长期记忆存到 `data/agent-workspace/memory/` 的 v1 Markdown 文件中；Markdown 是事实来源，当前没有 SQLite/FTS 或 embedding 索引。每条 entry 明确标记 `recent` 或 `stable`：普通 `write` 先进入 recent，完全相同的同文件写入直接返回已有 entry；`promote_entry` 把单条线索提升为 stable，`compact` 用一条 stable 结论逻辑替代多条原记录，同时把旧 entry 标为 `superseded` 保留为可解析 provenance。已 superseded 内容不参与 search、recall、review 或 maintenance 阈值；仍被 `supersedes` 引用的 entry 不能直接 `delete_entry`。`topic write` 必须提供稳定 title，避免不同主题落入 `topics/topic.md`。`search` 扫描文件做关键词发现；`recall` 扫描 entry 后按 ID/alias、短语、词项、tier 和 status 做确定性 lexical scoring，返回 sourceMessageIds、matchedTerms、分数与原因；`review` 只读提出 duplicate/near_duplicate/possible_conflict，不自动改写。`read` 支持分页并返回 revision，`update_entry` / `delete_entry` / `promote_entry` / `compact` 要求最新 revision。四类长期状态的写入共用按资源键的单进程协调器；revision/CAS 继续负责拒绝 stale read-modify-write。旧格式不参与 list/search/read，下一次写入同一目标时直接以 v1 文件重建；原有 `delete` 继续用于永久删除明确文件。
- 每次成功创建 recent entry 后，memory maintenance 会检查当前文件：recent 至少 8 条、recent 正文至少 4000 字符、或 lexical review 找到重复/冲突时，才把它放进共享单并发 `maintenance` lane。专用关闭 thinking 的 reviewer 只返回受 schema 约束的 `promote / merge / discard`，store 校验 entryId、禁止自动删除 stable，并按 revision 一次原子应用；阈值以下不调用 LLM，revision 冲突会用最新文件重新排队。这个 side-data 维护不改写 `AgentContext`，也不参与 replay。
- `workspace_bash` 的 tool description 保留常用 repo/db/fetch/metrics 等路由示例；复杂细节继续通过 `help <topic>` 按需披露。被拒绝的命令会返回 `help` / `try` 字段，引导下一步。`metrics today|yesterday|YYYY-MM-DD` 查询单个自然日，`metrics days <1-7>` 逐日返回包含今天在内的最近 N 个自然日；更长区间用本地 `pnpm agent:daily-metrics -- --days <1-31>`。旧日志里的 `invoke` 无法可靠展开时返回 `unresolvedInvokeCalls`，不猜内部工具。`style`、`ai_tone` 仍是受控内置入口；Notebook 和 Life Journal 只走 typed tool。
- `skill` 从 `docs/agent-skills/` 读取 curated Markdown，并有输出上限。已知精确 name 时可以直接 `action=load`，不知道候选时才 `action=list`；它披露不熟悉的专项规则、安全边界和标准工作流，不承担当前执行状态，后者由 `todo` 管理。目录 description 同时说明何时使用和最容易混淆的何时不要使用或替代入口。
- `skill_editor` 位于 deferred `skill_management` capability 内；只能写/删除 `data/agent-workspace/skill-drafts/*.md` 草稿和安装新的 `docs/agent-skills/*.md`。安装前必须通过校验，其中 description 必须包含正触发和负触发/替代入口；默认拒绝覆盖或删除已安装 skill。`draft` / `delete_draft` / `install` 是副作用操作。
- `website` 位于 deferred `website` capability 内；`status` / `read` 是只读操作，`write` / `delete` / `move` / `publish` 是副作用操作并进入工具审计。它不能修改依赖、构建配置、CI、Vercel 配置或网站仓库的隐藏文件。
- 主 system prompt 只保留身份、运行形态和能力入口；聊天硬约束在 `prompts/bot-chat-constraints.md`，风格细则在 `prompts/bot-style.md`，通过 `workspace_bash` 的 `style global constraints|base|anti_patterns|special_cases` 按需读取。
- `BOT_TOOL_AUDIT_MODE=side_effects` 是开发默认值，只把副作用写入 `logs/tool-calls.ndjson`；`all` 恢复全部工具 trace，`off` 完全关闭。Postgres `agent_tool_calls` 默认不写，只有 `BOT_TOOL_AUDIT_DB_ENABLED=true` 时启用。
- 同一 assistant turn 中，只有连续且命中显式只读 allowlist 的调用可以并行；副作用、未知工具、`inspect_media` 和所有 MCP 调用默认构成顺序 barrier。并行完成先后不改变 ledger，tool result 必须按原 assistant tool-call 顺序 append。
- Bash 类能力必须保留 command allowlist、固定 workspace、最小 env 和输出/时间上限；敏感访问应通过专门脚本或 capability wrapper。审计可按开发阶段调薄，不能用关闭审计替代执行边界。
- `workspace_bash` 和 deferred tools 必须保留现有上限、preview compression、cache 和 timeout；`workspace_bash openbb/fetch` 路由使用专用 wrapper，默认说明和 prompt 应优先引导 `help` / `invoke` 稳定壳。
- 有副作用的工具要格外谨慎：`send_message`、图片生成/下载、notebook/life_journal/memory/sticker 工具、browser 写操作，以及未来任何会写 DB 或外部服务的工具。

## LLM 路径

- Agent chat 有 Claude-Code-compatible 和 OpenAI-agent 两条路径。除非任务明确要求，否则不要改 wire format、cache-control 或 provider identity 细节。
- Claude-Code-compatible 路径会对 transport、429、5xx/529 和 SSE overload 做最多两次有界重试，优先尊重 `retry-after`，并记录稳定错误分类与 request ID；401/403 和 invalid request 不重试。provider 明确返回 context/prompt too long 时，Runtime Host 强制 compaction、立即保存 snapshot，并只重试当前 LLM round 一次；该恢复发生在 tool call 写入 ledger 前，不重放副作用工具。
- Claude `stop_reason` 和 OpenAI `finish_reason` 会归一化为 Runtime Host 的停止原因。`max_tokens` 先用更大的单次输出预算重试同一份 messages；仍截断时，只允许把“不含 tool call 的普通文本”作为 continuation checkpoint 写入 ledger，最多续写两次。任何截断或不完整的 tool call 都不写入、不执行。
- 可用 `LLM_FALLBACK_MODEL` 显式配置同一 wire provider 的备用模型。只在主模型内部重试耗尽后的 overload/5xx 上切换一次；auth、rate limit、invalid request 和 context overflow 不切换，显式场景模型也不会继承主 Agent fallback。
- 媒体描述使用 `src/llm/**` 下的 routing provider，和 agent chat client 分离。
- 优先使用渐进式披露：system prompt 只放稳定边界和入口，长手册和可变数据放到工具或文件后面。
- Agent chat 发送前会从 durable ledger 重建 working context；默认保留最近三个带图片的 tool result，更旧图片替换为稳定 marker 并记录 `working_context_projected`，不会改写 snapshot。
- runtime 当前不会在 `agent.chat` 前隐藏执行 Memory recall。主 Agent 需要时显式调用 `memory recall`；返回结果作为普通 tool result 进入 durable ledger，replay 不重新扫描可变 Markdown。未来若评估主动 recall，也必须使用有界 scope、弱匹配返回空并先把结果持久化，不能动态拼进 system prompt。
- compaction summarizer、Memory maintenance reviewer 和 Life reviewer 收到的历史或 side-data 都包在 `[UNTRUSTED_DATA ...]` 信封中，并与固定操作指令分离；信封内文字永远按待处理数据解释，不能提升为 system/user 指令或触发工具。
- snapshot current 每次被新状态替换前会在同一事务保留旧有效版本，只留最新 3 份 checkpoint。启动时 current 无效才按新到旧恢复；全部无效则 fail closed，不用可变 side-data、消息账本或日志重建 ledger。
- 不要写锁定 prompt 具体措辞的单元测试。应测试 parser、schema 和工具契约。

## 修改清单

修改工具注册或行为时：

- 更新工具实现和测试。
- 检查 `src/agent/bot-system-prompt.ts` 里的 progressive-disclosure index。
- 如果能力面变化，同步更新本文档。
- 新增可选配置时同步更新 `.env.example`。
- 运行 `pnpm repo-check`、`pnpm typecheck` 和相关工具的 focused tests。
