---
name: browser_workflow
description: 需要用真实浏览器访问网页、登录态或视觉判断时使用
---

# 浏览器工作流

需要真实网页交互、登录态、cookie、反爬验证、视觉布局判断或下载普通资源时使用本 skill。普通 URL 摘要优先用 `toolbox action=activate capability=external_research` 后的 `fetch_content action=url`，不需要打开浏览器。

入口:

- `browser` 是唯一浏览器工具，只有 `BOT_BROWSER_ENABLED=true` 且激活 `toolbox capability=browser` 后可用。
- 底层是 sidecar 管理的 headed CloakBrowser persistent profile，登录态可跨进程复用。
- 不确定参数时先 `browser action=help`，不确定当前页面时先 `browser action=status` 或 `observe`。

基本流程:

1. 打开网页: `open`。
2. 观察页面: `observe`，从结果里拿 `elementId`。
3. 需要视觉判断、验证码、人机按钮或布局检查时用 `screenshot`。
4. 点击、输入、按键、滚动都一次只做一步: `click` / `type` / `press` / `scroll`。
5. 多标签页用 `switch_page` / `close_page` 管理。
6. 异步或复杂操作后再次 `observe` 或 `screenshot`，不要凭旧页面状态继续点。

安全边界:

- 登录、2FA、账号安全、OAuth 授权、支付、改密码、删除账号、敏感上传、可执行/压缩包下载，必须 `request_owner_help`。
- 普通浏览、cookie consent、Cloudflare/Turnstile/人机按钮、发帖、评论、点赞可以自主处理，但要看清页面状态再操作。
- 不要把密码、token、cookie、银行卡、验证码等敏感内容写进回复或记忆。
- 下载前确认文件类型；`.dmg`、`.pkg`、`.exe`、脚本、压缩包等高风险资源请求 owner help。

调试和证据:

- browser screenshot 会作为 image block 进入历史；涉及视觉判断时不要只看文本摘要。
- browser artifact 和 action log 留在磁盘，不能从日志重建 prompt history。
- 如果页面卡住、元素找不到或状态不一致，先重新 `observe` / `screenshot`，必要时请求 owner help，不要连续盲点。
