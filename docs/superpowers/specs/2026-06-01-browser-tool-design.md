# 浏览器工具设计

日期：2026-06-01

## 目标

给 Luna 接入真实浏览器能力，同时保持 `qq-bot-v2` 的单主 Agent、永续上下文、prompt cache 稳定性和渐进式披露原则。

浏览器能力应该像 Luna 拥有真实的眼睛和手：

- 通过真实 Chromium session 浏览任意网站。
- 保持一个持久浏览器身份和登录 session。
- 阅读页面、点击、输入、滚动、截图、下载资源、留下本地批注。
- 尽可能自主处理常规反自动化中间页。
- 只有凭据、2FA、账号安全、支付或反复自动化失败时才请求主人协助。

本 spec 覆盖第一版实现范围：一个主 Agent、一个 `browser` 工具、一个本地浏览器 sidecar、一个持久 profile、真实浏览器集成测试。

## 非目标

- 第一版不做 browser sub-agent。
- 不做 Reddit 专用或论坛专用工具。
- 不把自然语言浏览任务执行器藏在工具内部。
- 第一版不做远程 noVNC 或浏览器 profile 管理 UI。
- Agent 不自动处理密码、cookie、token、2FA 或支付信息。
- 不把完整 DOM、完整 network log 或完整 console log 注入主上下文。

## 架构

`qq-bot-v2` 注册一个 `browser` 工具。这个工具不直接启动或控制 CloakBrowser，而是通过 loopback HTTP 调用本地 Browser Controller sidecar。

```text
BotLoopAgent
  -> ToolExecutor
    -> browser tool
      -> BrowserControllerClient
        -> http://127.0.0.1:<BOT_BROWSER_CONTROLLER_PORT>
          -> Browser Controller sidecar
            -> CloakBrowser launchPersistentContext
              -> headed Chromium window
              -> single persistent Luna profile
              -> multiple pages/tabs
```

Agent 仍然是唯一规划者。Browser Controller 只执行单步浏览器动作并返回观察结果。

### 组件

- `browser` tool：Agent 面向浏览器的唯一入口。负责校验 action 参数、调用 controller、截断文本输出、返回稳定 tool result。
- `BrowserControllerClient`：bot 内部 loopback HTTP client。负责短超时和错误归一化。
- Browser Controller sidecar：持有 CloakBrowser 进程、持久 profile、page registry、截图、下载、批注和浏览器动作审计日志。
- Browser artifacts：原始截图、下载文件和批注存到明确的浏览器 artifact 目录。
- `AgentContext`：保存 tool result，包括 Agent 主动截图时返回的 image block。它不依赖 controller 状态来 replay。

只有在浏览器能力被配置时才注册这个工具。运行时 controller 不可用时，工具返回结构化错误，不能拖崩主 bot。

## 浏览器工具 API

Agent 只看到一个工具：`browser`。它是单步 action 工具，不是任务执行器。

代表性 schema：

```ts
browser({
  action:
    | "help"
    | "status"
    | "open"
    | "switch_page"
    | "close_page"
    | "observe"
    | "click"
    | "type"
    | "press"
    | "scroll"
    | "screenshot"
    | "download"
    | "annotate"
    | "request_owner_help",
  pageId?: string,
  ...
})
```

常驻 tool description 保持短。详细用法、action 专属参数、示例和限制通过 `browser({ action: "help" })` 按需披露。

### Actions

- `help`：返回详细浏览器工具手册。
- `status`：返回 controller 状态、浏览器状态、profile 路径、active page 和所有已知 pages。
- `open`：在 active page 打开 URL，或按需创建新 page。
- `switch_page`：切换 active page。
- `close_page`：关闭一个 page。
- `observe`：返回默认页面视野：URL、标题、加载状态、页面摘要和带稳定 `elementId` 的可交互元素列表。
- `click`：点击 `elementId`。坐标点击只作为 element lookup 不足时的 fallback。
- `type`：向当前聚焦元素或指定 `elementId` 输入文本。支持追加输入和清空后输入。
- `press`：发送键盘按键或快捷键，例如 `Enter`、`Escape`、`Meta+L`。
- `scroll`：按方向和距离滚动页面或可滚动元素。
- `screenshot`：截取当前 viewport 或 full page。tool result 返回压缩 image block，并保存原图 artifact。
- `download`：从当前页面或指定元素触发下载，并按风险检查保存为 artifact。
- `annotate`：写一条关于页面、截图、下载或来源 URL 的本地批注。
- `request_owner_help`：记录 Luna 需要人类协助登录、2FA、修复 session、处理账号安全、支付或反复自动化失败。

### Page 模型

只有一个持久 profile，但可以同时打开多个 page。

- 每个 page 都有 `pageId`。
- `status` 返回所有 page 的 URL、标题、active 状态、加载状态和 `lastUsedAt`。
- action 默认作用于 active page，除非显式传入 `pageId`。
- `open` 可以复用 active page，也可以创建新 page。
- `switch_page` 只改变 active page，不改变网页内容。
- `close_page` 关闭 page，但不清除 profile 或 session。

主 Agent 仍然串行调用工具。多 page 支持意味着浏览器可以保留多个标签页、后台加载和下载，而 Agent 一次推进一步。

## Profile 与 Session

第一版使用一个持久浏览器 profile，代表 Luna 的唯一浏览器身份。profile 保存 cookies、localStorage、IndexedDB、缓存、扩展和浏览历史。

默认 profile 路径：

```text
data/browser-profile/luna/
```

Browser Controller 用 `launchPersistentContext` 以 headed 模式启动 CloakBrowser。需要人类协助时，主人可以直接在 Mac 上操作这个可见浏览器窗口。

Agent 不接收原始 cookies、localStorage、密码、token 或 profile 文件。它只能通过正常页面交互使用 session。

### 主人接管

主人接管不是为了常规浏览摩擦。Luna 应该先自己处理普通浏览器工作：

- Cloudflare 或 Turnstile 中间页。
- “I am human” 单击检查。
- Cookie consent。
- 年龄或地区确认。
- 普通弹窗、继续按钮和展开内容。

只有这些情况才请求主人：

- session 里没有可用登录态，需要输入用户名/密码。
- 2FA、短信、邮箱验证码、passkey 或设备批准。
- 账号安全变更。
- 真实账号的 OAuth 授权。
- 支付或购买流程。
- 身份材料或私密文件上传。
- 反复挑战失败或账号风控页面。

正常流程：

1. Luna 观察到需要人类协助。
2. Luna 调用 `browser({ action: "request_owner_help", ... })`。
3. 工具返回 `requiresOwnerHelp: true`。
4. Luna 用现有 `send_message` 私聊主人说明需要处理什么。
5. 主人在可见浏览器窗口里完成登录或恢复。
6. Luna 在同一个 page/profile 上继续 `observe`。

## 风险策略

风险检查放在 Browser Controller 层，不能只依赖 prompt 自觉。

### 低风险：允许

- 打开、阅读、搜索、滚动、展开、导航。
- Cookie consent 和普通弹窗。
- 常规反自动化中间页。
- 截图。
- 阅读和复制公开文本。

### 常规风险：允许并审计

- 填写普通表单。
- 发帖、评论、点赞、关注、star、收藏、上传普通文本或图片。
- 在欢迎 AI agent 或普通社区场景下进行账号行为。

这些能力属于目标中的真人级浏览器能力。默认允许，但写入浏览器动作审计日志。

### 高风险：必须请求主人

- 支付、购买、订阅、退款或金融行为。
- 密码、邮箱、2FA、passkey、恢复或账号安全设置。
- 第三方 app 的 OAuth 授权。
- 导出大量私密数据。
- 删除账号、仓库、帖子或重要用户内容。
- 下载或运行可执行文件、安装包、脚本或可疑压缩包。
- 上传身份证明或私密材料。
- 反复挑战失败或账号风控页面。

命中高风险时，controller 返回结构化拒绝：

```json
{
  "ok": false,
  "requiresOwnerHelp": true,
  "risk": "account_security",
  "reason": "The page asks for a 2FA code."
}
```

### 检测输入

第一版使用保守启发式，来源包括：

- 元素文本和 `aria-label`。
- 表单字段名、label、placeholder 和 autocomplete 值。
- 当前 URL、domain 和 path。
- 文件扩展名、MIME type 和下载文件名。
- 页面标题和目标元素周围文本。

密码、token、cookie、Authorization、卡号、2FA code 等敏感值永远不返回给 LLM，也不写入日志。

## 上下文与 Artifacts

设计遵循永续上下文契约：append 到 `AgentContext` 的 tool result 是历史事实。browser 工具不能修改、替换、删除或摘要化旧的浏览器 tool result。历史瘦身只能通过正式 compaction 路径。

### Observe

`observe` 是默认的低成本视野。它返回短且稳定的文本观察：

- URL。
- 标题。
- 页面加载状态。
- 截断后的页面摘要。
- 截断后的可交互元素列表。
- 稳定 element ID；它们在下一次 observe 或页面突变前有效。

`observe` 默认不带截图。

### Screenshot

`screenshot` 是视觉记忆路径。

- 它在 tool result 里返回 metadata 和压缩 image block。
- image block append 到 `AgentContext`，所以 Luna 在后续轮次里仍能把这张截图作为稳定历史的一部分继续看见。
- 原始全分辨率图片也保存为 artifact。
- artifact 用于审计、复查、发送或之后重新读取，但不是 LLM history 的替代品。

这能保留截图的意义。把每张截图都转成文字会丢失布局、相对位置、视觉遮挡、图标、颜色和图片内容。

### Downloads

下载是为了获取网页背后或网页链接的资源，不是为了普通阅读网页。

例子：

- 原图，而不是页面里渲染出的缩略图。
- PDF、报告、论文和手册。
- 文本、CSV、JSON、Markdown、日志等附件。
- 页面可能变化时用于留证的网页快照。
- 开发调试产物，例如导出文件、HAR、trace 或生成报告。
- Luna 之后可能通过 `send_message` 发送的材料。

下载文件保存到浏览器 artifact 目录，并返回 artifact 引用、metadata、大小、content type 和来源 URL。高风险文件类型必须请求主人。

### Annotations

`annotate` 写本地批注，不会发布到网站。

代表性路径：

```text
data/agent-workspace/browser/annotations/<domain>/<artifactId>.md
```

批注是页面或 artifact 的边注，不替代 `write_journal`。`write_journal` 仍然是 Luna 的通用日记/思考工具。

## 日志

每个 browser action 写一条 NDJSON 审计日志。它独立于 Prisma，也独立于 `AgentContext`。

代表性路径：

```text
logs/browser-actions.ndjson
```

字段包括：

- 时间戳。
- Action。
- Page ID。
- URL 和标题。
- 目标元素摘要或坐标。
- 风险级别和风险原因。
- 结果状态。
- Artifact IDs。
- 错误码。

现有 tool-call log 继续记录顶层 `browser` 工具调用。browser action log 记录浏览器专属细节。

日志必须脱敏敏感字段、标识符、cookie、token、密码、2FA code、支付字段和必要时的长输入文本。

## 错误与恢复

browser 工具返回结构化错误，不能拖崩 bot。

- `browser_controller_unavailable`：sidecar 未运行或不可达。
- `browser_start_failed`：controller 无法启动 CloakBrowser。
- `browser_crashed`：浏览器进程退出；controller 应在下一次 action 尝试恢复。
- `page_not_found`：page 已关闭或 page ID 过期。
- `element_stale`：element ID 已失效；Luna 应重新 `observe`。
- `navigation_timeout`：导航仍在加载或超时；结果包含当前 URL 和加载状态。
- `download_blocked`：下载风险策略拦截了文件。
- `requires_owner_help`：高风险或需要人类介入。

恢复入口：

- `status`：检查 controller、浏览器和 page 状态。
- `observe`：重建 element IDs。
- `open`：创建新 page。
- owner handoff：session 或账号状态需要人类输入时使用。

Artifacts 和审计日志在 controller 重启后仍保留。AgentContext replay 不重跑浏览器动作，只 replay 当时原始 tool result 字节。

## 配置

环境变量：

- `BOT_BROWSER_ENABLED`：为 true 时注册 `browser` 工具。
- `BOT_BROWSER_CONTROLLER_URL`：loopback URL，例如 `http://127.0.0.1:37921`。
- `BOT_BROWSER_PROFILE_DIR`：持久 profile 路径，默认 `data/browser-profile/luna`。
- `BOT_BROWSER_ARTIFACT_DIR`：截图、下载和批注路径，默认 `data/agent-workspace/browser`。
- `BOT_BROWSER_ACTION_LOG_PATH`：browser action 审计日志，默认 `logs/browser-actions.ndjson`。
- `BOT_BROWSER_ACTION_TIMEOUT_MS`：单 action 超时。

这些名字是设计的一部分。实现时应接入 `src/config/index.ts`，并写入 `.env.example`。

## 测试与验证

核心验证使用真实 Browser Controller 和真实 CloakBrowser，对本地 fixture 页面执行。Mock 测试不是主要验收路径，因为这个能力的风险在真实浏览器行为里。

### 真实浏览器集成测试

启动 controller 和真实持久 CloakBrowser profile，然后用本地 HTML fixtures 验证：

- `open -> observe -> click -> type -> press -> scroll -> screenshot -> download`。
- 每一步都有短超时，例如 5-15 秒。卡住即失败。
- `screenshot` 返回 image block，并保存原始 artifact。
- `download` 保存安全文件并拦截高风险文件。
- `observe` 输出被截断。
- observation 后 element IDs 可用；失效时可以通过新的 observation 恢复。

### 多 Page 测试

- 打开两个 fixture pages。
- `status` 能列出两个 pages。
- `switch_page` 改变 active page。
- 显式 `pageId` 的 action 作用到正确 page。
- `close_page` 更新 page registry。

### 风险测试

Fixture pages 包含代表性控件：

- "Post comment" 应允许并审计。
- "Pay now" 应请求主人。
- "Connect OAuth" 应请求主人。
- "Change password" 应请求主人。
- "Download .dmg" 或类似高风险下载应被拦截。
- 普通 cookie consent 和 "I am human" 按钮应允许。

### 上下文测试

尽可能使用真实 `browser` tool result：

- 把 screenshot result append 到 `AgentContext`。
- export snapshot。
- 确认同一个 append 后的 snapshot 字节稳定。
- 确认 browser 工具不会修改旧 messages。

### 外部网站手工验证

外部网站不作为稳定 CI 依赖，只做手工验收：

- 打开真实网站。
- 让 Luna 处理常规反自动化中间页。
- 对登录/session 修复使用 owner handoff。
- controller 重启后验证 session 保留。
- 在欢迎 AI 的测试站验证普通发帖/评论。
- 检查 `logs/browser-actions.ndjson` 和 `logs/tool-calls.ndjson`。

## 实现决策

- Sidecar 入口是 `scripts/browser-controller.ts`。
- 共享 controller/client/types 模块放在 `src/browser/**`。
- 本地协议类型放在 `src/browser/protocol.ts`，由 tool 和 sidecar 共享。
- Profile 目录 `data/browser-profile/` 必须加入 gitignore。
- 写 launcher 前先验证目标环境里的 CloakBrowser JavaScript package API 和 persistent context 支持。
- Tool description 保持短，详细说明通过 `action:"help"` 渐进式披露。
