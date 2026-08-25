# Agent 工具

工具注册集中在 `src/agent/tools/index.ts`。声称某个工具存在前，先查这个文件。

## 默认可见能力

- 主动休息：`rest` 是唯一的主动暂停入口。只有此刻真正想休息时才调用，并明确给出 `durationMinutes=1..60`（默认 10）、真实 `reason` 和醒后立即执行的 `resumeAction`；注意事件会提前打断，结束后立刻回到行动循环。每次结束或被打断后进入进程内 60 分钟冷却，期间再次调用会返回 `rest_cooldown` 并要求去做其他事情。完成一件事、暂时没想法、owner 不在线或等待外部回复都不是休息理由，普通轮次会直接寻找下一件可执行的事。
- 短期调度：`schedule action=create|list|get_occurrence|cancel`，active job 的公开 ID 字段统一为 `id`。`create` 只接受一次性 `at` 或 `afterSeconds`，触发必须位于 30 秒到 3 天内，最多 20 个 active job。同名同时间创建幂等返回 `existing`，同名不同时间返回冲突及已有 `id`，需先 cancel；`list` 返回有界公开摘要。active 状态保存在 schedule store，触发正文只写一次 occurrence store；到期 notification 只给名称、时间和 `get_occurrence` 打开参数，不执行预存命令。它是 normal+interrupt，轮次边界低于 high notification、高于 active Goal 和 passive notification。
- 持久目标：`goal action=get|create_self|replan|complete|report_blocker|abandon_self`。没有未完成 Goal 时，Agent 可以为自己的兴趣直接创建 `origin=self` 的持久目标，必须给出真实 `motivation`、可核验 `completionCriteria` 和立即执行的 `currentCommitment`；owner Goal 初始没有承诺时由 Agent 先 `replan`。默认预算 1,000,000 tokens，单个上限 10,000,000，60 秒冷却和滚动 24 小时最多 64 个只是失控保险丝。Agent 可以放弃 self Goal，但不能放弃 owner Goal。配置的 owner 仍可用私聊 `/goal` 创建、暂停、恢复或取消，owner Goal 会直接抢占 self Goal。轮次边界优先级是 high+interrupt notification > normal+interrupt notification > active Goal > passive notification；前台仍是单一串行 BotLoop，等待后台或外部输入时可以做其他事情。`complete` 必须提交逐项真实证据，并对 owner/self Goal 各执行一次独立、无工具的 LLM 验收；只有 `{ok:true}` 才落完成状态，拒绝或验收不可用会保持 Goal 活跃且本次不重试。同一 blocker 每个连续 Goal round 用相同 `blockerKey` 报告，第三轮才转 `blocked`。Goal token budget 按主 Agent 未缓存 input 加 output 计量；judger 等辅助 LLM 使用量尚未计入。只有明确的 provider 硬额度/账单上限才转 `usage_limited`，普通临时 429 仍走已有有界重试和 round backoff。
- QQ 与飞书发送位于 deferred `chat` capability：用 `help action=describe` 查看 schema 后，直接 `invoke conversation open` 显式打开允许的群或好友，最后 `invoke send_message` 发送文本、图片、图文或受控音乐卡片。`work` 必填：无后续承诺用 `state=none`；当前会话内马上续做用 `state=continue`，只保护下一轮且不跨重启；持久 Goal 的进度消息用 `state=goal_progress + goalId`，并由 before-tool hook 确认该 Goal 当前 active 且有 `currentCommitment`。
- QQ 目录：`qq_directory`（分页列出/搜索 NapCat 当前全部好友；群目录只披露当前已加入且配置在 `prompts/groups.md` 的群；`profile` 按 QQ 号合并当前目录名和消息事实账本中观察到的历史群名片/昵称）。
- 稳定按需壳：`help`（`list` / `describe` capability 或内部工具 schema）和 `invoke`（直接调用按需内部工具）。安全仍由目标工具 schema 和 policy 约束，不持久化激活状态。
- 知识和历史：`memory`（稳定长期记忆）、`notebook`（按稳定 topic 维护研究/阅读/市场/项目过程）、`life_journal`（经历、感受、梦和 Agenda）、`skill`、`inbox`（list/read 多来源消息正文）。四类长期状态的人类可读叙述必须以中文为载体，技术标识可保留原文但要放进中文说明；结构字段、ID 和 Agenda 固定分区名保持原样。
- 表情包：`collect_sticker`（收藏、移除、列表、搜索和随机候选）。
- 外部内容：typed `fetch_content` 和配置后可用的 `web_search`。金融能力统一位于 deferred `finance`：按配置包含 `openbb_cli`、`moomoo_skill`、`crypto_paper` 和 `trading_agent`。
- 风格和文本判断：`chat_style` 按需读取聊天约束、风格和群定制；发送路径不再运行阻塞式 AI 腔分类器。
- 心理医生：`psychologist` 是默认可见的只读 LLM 工具，用于自我反思与行为检查，不提供医学诊断。只有当主 Agent 准备以“以后再说”“不打扰”“算了”“先歇着”等理由停下仍可立即推进的方向时，才把完整第一人称想法交给它；已经在推进、只是客观描述状态、确实没有当前方向或健康交还控制时不调用。它返回稳定的 `hasNegative` / `rewritten`，结果作为普通 tool result 进入 ledger；工具本身不保存会话状态，也不在每轮隐藏执行。
- 运行时工作：`background_task`（通用异步任务 list/get；get 的文本结果有通用上限）、只读 `workspace_bash`；普通私有工作文件通过 deferred `workspace_management` 内的 `workspace_file` 修改。任务 registry 持久化到 `BOT_BACKGROUND_TASK_STATE_PATH`；所有遗留 running 在重启时明确变成 `interrupted`。全局未完成任务数由 `BOT_BACKGROUND_TASK_MAX_ACTIVE` 限制，默认 8；排队任务也占额度，超限会在启动图片生成、后台抓取或交易研究前明确拒绝。完成/失败 notification 不复制 description、summary 或结果正文，只携带状态和 `background_task get` 打开动作。当前定时唤醒不走 task registry，而由上述独立 schedule/occurrence store 恢复。

## Deferred capability

- `browser`：配置 `BOT_BROWSER_ENABLED=true` 后出现，内部工具是单一 action-driven `browser`；截图、下载和 annotation 返回后，artifact retention 清理由 sidecar 的单 worker 合并执行。
- `finance`：按配置包含 `openbb_cli`、`moomoo_skill`、`crypto_paper` 和 `trading_agent`。前三项负责数据与受限模拟交易；已有具体金融问题且需要跨来源证据、可复现策略规则、反证或历史回测时，使用 `trading_agent` 委派给本机 Vibe-Trading Agent。
- `website`：配置 `BOT_WEBSITE_ENABLED=true` 和独立网站仓库路径后出现，内部工具是 `website`，用于维护 Luna 的 Astro 个人网站并发布到配置分支。
- `external_research`：内部 `fetch_content` 只暴露普通网页和 Reddit action；配置 `TAVILY_API_KEY` 后同时包含 `web_search`。
- `fetch_content action=url` 默认同步返回网页摘要；预计较慢或想同时处理其他事情时可传 `background=true`，它进入最多 3 并发的 `network` lane，立即返回 `taskId`，完成后通过 `background_task` 取结果。
- `media_generation`：内部工具是 `generate_image`，创建图片生成/编辑后台任务，`count=1..4` 时固定最多并发 2 个图片请求，后续用 `background_task` 查结果。
- `media_inspection`：内部工具是 `inspect_media`，用入站 `mediaId` 或生成图 `ephemeralRef` 返回有界真实预览 image block；缺失的入站图片描述进入 `media-description` lane，当前结果标记 `descriptionStatus=pending` 而不等待模型。原始媒体事实仍可保存，但图片解码统一限制为最多 4000 万像素、单边最多 8192px，动画只读取第一帧；超限图片不会进入预览或视觉模型请求。
- `media_fetch`：内部 `fetch_content` 只暴露图片 URL / QQ 头像 action；激活它不会放开普通网页或 Reddit 抓取。
- `workspace_management`：包含 `workspace_file` 和只读 `workspace_bash`。后者只允许 `pwd/ls/rg/cat/head/tail/wc`，不经过 shell；外部抓取、风格和金融分别用 typed capability。
- `document_reading`：内部工具是 `read_file`，只接受 `inbox` 返回的 `type=file` 的 `mediaId`；支持有界分页读取纯文本、PDF、DOCX、XLSX、PPTX、RTF 和 OpenDocument，不接受路径或 URL，也不执行文件内容。
- 跨平台当前会话保存在 runtime singleton 的 `conversation_focus`；`inbox_read_cursors` 记录各来源实际读取到的 messages row。它们用于重启恢复运行控制状态，不是 LLM 可见事实，不写入 ledger message。focus 只由 `conversation open/close` 改变，新 mailbox 不会自动切换它。
- `invoke` 的 schema/capability resolution 是内部路由，不单独记成功 trace。对外 schema仍要求 `args` 是对象；若 provider 误传可解析为 JSON 对象的字符串，runtime 会在 schema 校验前归一化。调用只记录一次真实目标工具结果，hooks 也只围绕最终执行路径运行一次。

## 结果契约

- 工具对 LLM 返回的事实只放在 `content`。运行时可以附带 `outcome` 和 `effects`，但二者不进入 `AgentContext`；循环语义读取结构化 outcome/effect，不反解析结果文本。`rest` 在工具调用内部等待，结束或被打断后以 `continuation=immediate` 返回。
- 工具可以用 `outcome.progress=false` 声明一次成功调用没有获得新信息、改变状态或完成外部动作；事实性的 `content` 仍正常进入 ledger。普通无进展不会触发空闲等待，Runtime Host 会立即要求下一轮改做其他行动。
- `outcome.continuation` 与进展分离：`immediate` 请求一次立即决策；`wait_event` 表示已启动或观察到真实后台工作，主循环不轮询它而是立刻做其他事；`wait_attention` / `stop` 表示当前方向告一段落，但不会停止整个 Agent；只有 `backoff` 表示一次有界技术退避。`continuationDetail` 最多透传 1000 字符到可丢弃活动观察面，不进入 ledger。后台任务 start、运行中的 `background_task get/list` 返回 `wait_event`；完成事件稍后进入注意队列。重启后直接查询不再有本机 completion event 保证的持久远端 session 时返回 `backoff`，避免故障紧密重试。
- 需要后续程序判断的结果使用稳定 JSON，并包含明确的成功状态和错误 code。面向人的摘要或错误说明放在具名字段中，不与 JSON 前后拼接自然语言。
- schema 校验失败返回具体 `issues`、当前工具名和立即重试同一工具的提示；未知顶层工具返回当前 `availableTools` 和恢复提示，已移除的 `send_image` / `workspace_command` 分别定向引导到 `send_message.imageRef` / `workspace_bash`，不做静默兼容。
- `continuation=immediate` 的可恢复失败最多保留 3 个立即纠错轮；成功重试或额度用完后回到普通 cooldown。该进程内状态不进入 ledger 或 runtime singleton。
- 外部搜索、网页、Reddit 和表情包结果按字段与条目做上限控制，并用 `truncated` 表示不完整；禁止截断完整 JSON 字符串。
- `workspace_bash` 的直接命令和 `openbb_cli` 返回命令信封，区分退出码、内容格式、正文、stderr 与截断状态。任意 stdout 只作为字符串装入信封，不因看起来像 JSON 就自动解释。
- `trading_agent action=start|continue` 返回本地 `taskId` 和 Vibe 的 `sessionId` / `attemptId`。正常完成后用 `background_task action=get` 读取有界结果；qq-bot 重启导致内存 task 丢失时，凭 `sessionId` 调 `status` / `result` 直接从 Vibe 的持久 session 恢复，不从日志重建。

## Browser

- `browser` 是单一 action-driven 内部工具，配置条件是 `BOT_BROWSER_ENABLED=true`，默认不常驻；用 `help action=describe tool=browser` 查看 schema，再用 `invoke tool=browser args={...}` 调用。
- bot 进程只通过 loopback HTTP 调用 browser sidecar；sidecar 用 `pnpm browser:controller` 启动。
- sidecar 使用 CloakBrowser `launchPersistentContext()`，默认 headed、persistent profile、`humanize=true`。
- CloakBrowser 启动参数走 `.env.example` 里的 `BOT_BROWSER_*`：`HEADLESS`、`HUMANIZE`、`HUMAN_PRESET`、`PROXY`、`GEOIP`、`TIMEZONE`、`LOCALE`、`ARGS`、`EXTENSION_PATHS`。
- screenshot 返回压缩 image block 并进入 `AgentContext`；artifact 和 action log 留在磁盘，不从日志重建 replay。
- browser artifact 默认最多保留 50 个且最长 14 天；每次新增截图、下载或 annotation 后，只清理 controller-owned 的 `screenshots/`、`downloads/`、`annotations/`，配置项是 `BOT_BROWSER_ARTIFACT_MAX_FILES` / `BOT_BROWSER_ARTIFACT_MAX_AGE_MS`。清理失败记 warning，但不让当前浏览动作失败。
- 登录、2FA、账号安全、OAuth、支付、可执行/压缩包下载等高风险动作必须请求 owner help；普通浏览、cookie consent、Cloudflare/Turnstile/人机按钮可自主处理。

## Website

- 网站源码放在独立 Astro 仓库中；owner 负责首次建站、Git 认证、Vercel 项目和域名，bot 通过 `BOT_WEBSITE_REPO_DIR` 访问本机 checkout。
- `website action=status|read|write|delete|move|publish` 分别用于查看状态、读取、写入、删除、移动和发布。读取返回 revision；覆盖、删除或移动已有文件必须带最新 revision。`BOT_WEBSITE_PUBLIC_URL` 仅用于状态/发布结果提示，不参与部署鉴权。
- 读写路径允许 `src/**` 中受支持的 Astro 源码、内容、样式和素材，以及 `public/**` 中受支持的静态资源；因此 bot 可以建立页面、组件、布局和内容分类结构。仓库根配置、依赖、CI、部署配置和脚本仍不在允许范围；绝对路径、隐藏路径、路径逃逸、符号链接和非普通文件会被拒绝。
- `publish` 只接受配置分支上的允许路径变更；先运行 `BOT_WEBSITE_CHECK_COMMAND`，再次校验工作区和暂存区，再 commit 并 push。Vercel 由网站仓库的 push 自动触发。

## 安全规则

- 对外 QQ 或飞书发言必须走统一 `send_message`，底层由 `MessageDelivery` 路由到平台 adapter。每次动作使用稳定 UUID；结果只可能是 `sent`、`failed` 或 `delivery_unknown`，后两者都不会伪装成功或自动重试。
- `send_message` 的 target 必须由当前 conversation focus 明确给出。不能从 memory、消息文本或日志推断 target；切换来源时必须重新 `conversation open`。
- `send_message.music` 只接受 qq/163/kugou/kuwo/migu 的歌曲 ID，或字段受限且 URL 必须为 HTTPS 的 custom 音乐卡片；不接受任意 JSON 卡片。
- assistant text 是内部历史/推理，不是公开发送通道。
- `send_message` 成功不会隐式结束 Agent 当前活动；下一轮继续当前方向或立刻选择另一件事。只有真正想主动休息时才调用 `rest`。
- content-only 且无 tool call 的 assistant 输出不会发送或执行。Runtime 会追加受控 `runtime_correction` 并立即重试一次；连续第二次进入一分钟可打断等待，防止既假完成又紧密空转。
- QQ 群策略仍以 `prompts/groups.md` 为唯一来源：普通群消息不唤醒或打断 Agent；`mentions` 群只进入被动 inbox，`selective` / `active` 群可以额外形成 passive notification。飞书群以 `BOT_FEISHU_GROUP_IDS` 明确 allowlist；普通消息被动入库，结构化 @bot、编辑和撤回可以形成 attention。QQ 私聊目标必须是 NapCat 当前好友；飞书群目标必须在 allowlist，私聊目标必须已经由 Gateway 观察到。未授权会明确拒绝，不会模拟成功。
- 私聊的主动发言冷却只限制没有同 target pending mailbox 的真正 ambient send。对新入站私聊的回复不必为了绕过冷却而添加 `reply_to`；`reply_to` 用于对应平台的引用/回复展示。
- `qq_directory` 是只读目录。`list_friends` / `search_friends` 覆盖 NapCat 当前全部好友，因此这些结果都可作为 private `send_message` target；`list_groups` 只返回 NapCat 当前群列表与 `prompts/groups.md` 群 section 的交集，不扩大群监听或发送授权。`profile` 以 QQ 号为主键，把当前好友 remark/nickname 与 `messages` 中同一 sender 的群名片、sender nickname、出现群和时间合并为带来源的 identity view；它不把昵称当权限或稳定事实。结果有条数上限和 offset 分页，不提供加删好友、加退群或群管理动作。
- 群 `send_message` 最终失败后才按需查询机器人自身的当前禁言状态；确认命中时 tool result 返回 `reason=group_muted` 和可用的 `mutedUntil`，否则返回 `reason=send_failed`。该事实不缓存，也不会阻止后续真实发送。
- 外部工具必须保留输出上限和超时；审计强度由 `BOT_TOOL_AUDIT_MODE` 控制，开发默认只记副作用。
- Agent 不使用通用人工审批层；工具调用在各自的 target、revision、路径、schema、超时、allowlist 和审计边界内直接执行。
- `inbox list` 只列出最近扫描窗口内 `latestRowId > lastReadRowId` 的待读来源；`read` 未显式传 `afterRowId` 时从持久已读 cursor 继续，并只推进到本次有界输出实际展示的最后一行。群读取必须显式指定监听白名单内的 groupId；私聊读取必须显式指定 peerId。read 结果用结构化 `media[].mediaId` 披露入站媒体 handle，整体仍有行数和字符上限，并作为普通 tool result 进入 AgentContext。群文件上传 notice 会用稳定的负数 synthetic messageId 落入同一 mailbox，此时 `replyable=false`，只能 ambient 回复。
- `read_file` 位于 deferred `document_reading` capability 内，只能解析已落库的消息文件 handle；QQ 与飞书媒体都先进入统一 `media` / `media_blobs` 后才能读取。单次返回和可解析输入都有上限，压缩包与旧版 DOC/XLS/PPT 明确拒绝。
- `workspace_bash` 的 workspace/repo 文件命令都只读且不经过 shell；只允许 `pwd/ls/rg/cat/head/tail/wc`。普通文件修改必须走 `workspace_file`，不能用它访问数据库、网络、金融、风格或指标。repo view 不能读取 secrets、runtime data、logs、`node_modules`、`.git` 或私有群 prompt 文件。
- `moomoo_skill` 只路由到固定 `skills/moomooapi/scripts/**` 下的代码内 allowlist。三个交易写脚本必须显式传唯一的 `--trd-env SIMULATE`；`REAL`、`--confirmed`、加密货币、组合订单、任意 Python/脚本路径和实时订阅长进程都会被拒绝。
- `crypto_paper` 是独立 typed tool，只调用 Moomoo `get_snapshot.py` 获取 `CC.*USD` 买一/卖一行情，不创建 Crypto 交易 context。`buy` / `sell` 需要幂等 `clientOrderId`，资金和持仓在单个 serializable PostgreSQL transaction 中更新；`reset` 清空当前持仓并递增 generation，但保留历史订单。查询不是副作用，买卖和重置进入工具审计。
- `trading_agent` 只连接配置的 loopback HTTP origin，拒绝远端 URL、URL 路径、凭据内嵌和重定向；请求、后台任务和结果都有超时/字符上限。发送给 Vibe 的每个 prompt 都附加固定的研究边界，禁止真实下单、撤单、券商授权、资金划转、定时任务和对外消息。`start` / `continue` / `cancel` 作为副作用审计，`status` / `result` 只读。
- `workspace_file action=list|read|write|replace|delete|move` 只维护普通文本工作文件。读取返回 revision，修改已有文件必须带最新 revision；拒绝 hidden/symlink/路径逃逸/二进制、重复 `data/agent-workspace` 前缀，以及 `notebook/**`、`life/**`、`memory/**`、`skill-drafts/**`、`browser/**` 等 managed path；旧 `journal/**` 也继续保留为受管路径，避免普通文件工具误改历史数据。
- `notebook action=write|list|search|read|update|delete|compact` 把研究、阅读、市场观察、项目过程和其他主题笔记存到 `notebook/<kind>/YYYY-MM.md`。每条记录必须有稳定单行 topic 和稳定 ID；list/search 可按 kind/topic 过滤，read 返回月文件 revision，修改要求最新 revision 并原子写回。compact 只允许同 kind、同月、同 topic 的记录。过程信息写 Notebook，稳定结论写 memory，经历、感受和梦写 Life Journal。
- `life_journal action=write|read_recent|read_day|read_entry|update|delete|compact|read_agenda|write_agenda` 让主 agent 显式维护 Life Journal 和 Agenda。完整 compact 前用 `read_entry` 或分页 `read_day` 获取原文；修改要求最新 revision。只有看见明确空白、重复或结构污染时才做有界整理。主循环没有旁路 Life reviewer，不会自动从每轮工具结果写 Journal、Agenda 或 Memory。
- `collect_sticker` 位于 deferred `sticker_management` capability，不是 `workspace_bash` 子命令；`action=collect|list|search|random|remove` 必填。`remove` 只删除表情池记录，不删除原始 Media。
- `memory` 对主 Agent 只暴露 `remember|recall|correct`，使用 `data/agent-workspace/memory/` 的 v2 Markdown；Markdown 是事实来源，没有 SQLite/FTS 或 embedding 索引。`self` 固定写入 `self/self.md`，`topic` 固定写入 `topics/topics.md`；调用时的 title 作为 entry alias 保留并参与 recall。人物使用平台中立 participant key，普通事实按来源会话落入 `people/<participant>/conversations/<encoded-conversation-key>.md`；群体事实落入 `groups/<encoded-conversation-key>.md`。只有配置的主人 QQ/飞书身份会统一为 `owner` 并允许主人自述进入 `people/owner/core.md`，其他用户和群保持平台隔离。person/group remember 必须提供真实 `sourceMessageRowIds` 和对应 `memoryKind`；runtime 从 Message row 推导 context、`assertedByIds` 和证据语义。person recall 必须带 participant key 和当前 `context`，group recall 使用 `conversation list` 返回的 conversation key；每个 match 同时返回 entry ID 与文件 revision，可直接交给 `correct` 做 revision-checked 原子替换。
- 每次成功创建 recent entry 后，memory maintenance 会检查当前文件：recent 至少 8 条、recent 正文至少 4000 字符、或 lexical review 找到重复/冲突时，才把它放进共享单并发 `maintenance` lane。专用关闭 thinking 的 reviewer 只返回受 schema 约束的 `promote / merge / discard`，store 校验 entryId、禁止自动删除 stable，并按 revision 一次原子应用；阈值以下不调用 LLM，revision 冲突会用最新文件重新排队。这个 side-data 维护不改写 `AgentContext`，也不参与 replay。
- `skill` 从 `docs/agent-skills/` 读取 curated Markdown，并有输出上限。它披露不熟悉的专项规则、安全边界和标准工作流，不承担当前执行状态。
- `website` 位于 deferred `website` capability 内；`status` / `read` 是只读操作，`write` / `delete` / `move` / `publish` 是副作用操作并进入工具审计。它不能修改依赖、构建配置、CI、Vercel 配置或网站仓库的隐藏文件。
- 主 system prompt 只保留身份、运行形态和能力入口；常驻提示词位于 `prompts/system/`，聊天硬约束与风格卡片位于 `prompts/chat-style/`，通过 typed `chat_style` 按需读取。
- `BOT_TOOL_AUDIT_MODE=side_effects` 是开发默认值，只把副作用写入 `logs/tool-calls.ndjson`；`all` 恢复全部工具 trace，`off` 完全关闭。Postgres `agent_tool_calls` 默认不写，只有 `BOT_TOOL_AUDIT_DB_ENABLED=true` 时启用。
- 同一 assistant turn 中，只有连续且命中显式只读 allowlist 的调用可以并行；副作用、未知工具和 `inspect_media` 默认构成顺序 barrier。并行完成先后不改变 ledger，tool result 必须按原 assistant tool-call 顺序 append。
- Bash 类能力必须保留 command allowlist、固定 workspace、最小 env 和输出/时间上限；敏感访问应通过专门脚本或 capability wrapper。`openbb_cli` 子进程默认只继承 PATH/HOME/locale/临时目录，数据源确需的 API key 必须由 operator 用 `OPENBB_CLI_INHERIT_ENV` 显式列出，不能继承整个 Bot 环境。审计可按开发阶段调薄，不能用关闭审计替代执行边界。
- `workspace_bash` 和 deferred tools 必须保留现有上限、preview compression、cache 和 timeout；网络与外部程序只通过专用 typed wrapper。
- 有副作用的工具要格外谨慎：`send_message`、图片生成/下载、notebook/life_journal/memory/sticker 工具、browser 写操作，以及未来任何会写 DB 或外部服务的工具。

## LLM 路径

- Agent chat 有 Claude-Code-compatible 和 OpenAI-agent 两条路径。除非任务明确要求，否则不要改 wire format、cache-control 或 provider identity 细节。
- Claude-Code-compatible 路径可用 `LLM_PROVIDER_CLAUDE_THINKING_EFFORT=low|medium|high|xhigh|max` 配置 adaptive thinking effort；只有 `LLM_PROVIDER_CLAUDE_THINKING=adaptive` 时才发送 `output_config.effort`。Anthropic-compatible provider 可能宽松接受或忽略该字段，需以真实端点和评测结果判断是否生效。
- Claude-Code-compatible 路径会对 transport、429、5xx/529 和 SSE overload 做最多两次有界重试，优先尊重 `retry-after`，并记录稳定错误分类与 request ID；401/403 和 invalid request 不重试。provider 明确返回 context/prompt too long 时，Runtime Host 强制追加 compaction entry，并只重试当前 LLM round 一次；该恢复发生在 tool call 写入 ledger 前，不重放副作用工具。
- Claude `stop_reason` 和 OpenAI `finish_reason` 会归一化为 Runtime Host 的停止原因。`max_tokens` 先用更大的单次输出预算重试同一份 messages；仍截断时，只允许把“不含 tool call 的普通文本”作为 continuation checkpoint 写入 ledger，最多续写两次。任何截断或不完整的 tool call 都不写入、不执行。
- 可用 `LLM_FALLBACK_MODEL` 显式配置同一 wire provider 的备用模型。只在主模型内部重试耗尽后的 overload/5xx 上切换一次；auth、rate limit、invalid request 和 context overflow 不切换，显式场景模型也不会继承主 Agent fallback。
- 主 Agent、compaction、Memory maintenance、Goal judge、主动性自检、startup persona probe、`fetch_url` 摘要和长期状态翻译统一经 `observeLlmCall()` 记录一次调用。成功、失败和取消都生成独立 callId；evidence 只保留四段结构摘要与 SHA-256 指纹，用工具名和 block 类型判断工具是在 canonical 组装、wire 翻译、provider 返回还是统一解析阶段丢失。不得把 prompt/response 正文、工具参数、图片数据、provider headers 或错误 message 放进 evidence；观察写入失败不能影响原调用，也不能成为 replay、compaction 或 prompt 的输入。
- `psychologist` 的固定规则原文位于 `prompts/tools/psychologist.md`，每次只把本次独白作为 user message 追加。Claude-Code-compatible 路径因此复用现有最后 system block 的 1h cache breakpoint；是否真正命中仍以 `operation=agent.psychologist` 的 `cachedTokens` 为准。OpenAI-compatible provider 是否缓存由对应上游决定。缓存只复用固定输入前缀，不是工具状态或长期记忆。
- 媒体描述使用 `src/llm/**` 下的 routing provider，和 agent chat client 分离。它是可缺失的 best-effort 增强：自动路径只对新图片/贴纸尝试一次，不扫描历史 backlog，不做 SDK 或队列重试；视频、语音和文件只允许显式按需调用。
- 优先使用渐进式披露：system prompt 只放稳定边界和入口，长手册和可变数据放到工具或文件后面。
- Agent chat 发送前会从 durable ledger projection 构建 working context；默认保留最近三个带图片的 tool result，更旧图片替换为稳定 marker 并记录 `working_context_projected`，不会改写 canonical ledger。
- runtime 当前不会在 `agent.chat` 前隐藏执行 Memory recall。主 Agent 在上下文不足时显式调用 `memory recall`；person/group 带具体 `id` 做定向召回，已有足够且未冲突的上下文时不重复调用。返回结果作为普通 tool result 进入 durable ledger，replay 不重新扫描可变 Markdown。未来若评估主动 recall，也必须使用有界 scope、弱匹配返回空并先把结果持久化，不能动态拼进 system prompt。
- OpenAI compaction、Claude split-turn fallback 和 Memory maintenance reviewer 收到的历史或 side-data 都包在 `[UNTRUSTED_DATA ...]` 信封中，并与固定操作指令分离。Claude 普通 compaction 为复用主 prompt cache，会保留主 system、tools 和原始 working-context prefix，再追加可信 control message；返回的 tool call 永不执行。两种形态中的历史文字都只能作为待压缩数据，不能提升权限或触发工具。
- checkpoint 只是 canonical ledger projection 的可丢弃缓存。启动时必须先验证 ledger/runtime；checkpoint 不匹配时直接重建，重建也失败则 fail closed，不能用可变 side-data、消息账本或日志补历史。
- 不要写锁定 prompt 具体措辞的单元测试。应测试 parser、schema 和工具契约。

## 修改清单

修改工具注册或行为时：

- 更新工具实现和测试。
- 检查 `src/agent/bot-system-prompt.ts` 里的 progressive-disclosure index。
- 如果能力面变化，同步更新本文档。
- 新增可选配置时同步更新 `.env.example`。
- 运行 `pnpm repo-check`、`pnpm typecheck` 和相关工具的 focused tests。
