---
name: browser_workflow
description: 需要真实网页交互、登录态、反爬验证、视觉判断或下载流程时使用；普通公开 URL 的文本抓取或摘要不要使用，改用 external_research。
---

# 浏览器工作流

需要真实网页交互、登录态、cookie、反爬验证或视觉布局判断时使用本 skill。普通 URL 摘要优先直接通过 `invoke tool=fetch_content args={...}` 读取，不需要打开浏览器。

入口:

- `browser` 是唯一浏览器内部工具，只有 `BOT_BROWSER_ENABLED=true` 时才会出现在 help 列表，并通过 `invoke tool=browser args={...}` 调用。
- 底层是 sidecar 管理的 headed CloakBrowser persistent profile，登录态可跨进程复用。
- controller 默认 `read-only`；owner 已建立的登录态可用于阅读，但 Agent 不接收账号密码、验证码、token 或 cookie。
- owner 明确要求“真正刷 Reddit”或使用登录态阅读时，走本 browser 工作流，不退回只读 Reddit fetch wrapper。
- 不确定参数时先 `help action=describe tool=browser` 或 `invoke tool=browser args={"action":"help"}`，不确定当前页面时先 `status` 或 `observe`。

基本流程:

1. 打开网页: `open`；默认复用当前页面，只有确实需要并行保留页面时才传 `newPage=true`。
2. 读取页面: `read`；长页面用返回的 `nextTextOffset` 继续读取。需要交互时再 `observe` 拿 `elementId`。
3. 需要视觉判断、验证码、人机按钮或布局检查时用 `screenshot`。
4. 点击、按键、滚动都一次只做一步: `click` / `press` / `scroll`；只读模式不要调用 `type`、`download` 或 `annotate`。
5. 多标签页用 `switch_page` / `close_page` 管理；全部关闭后，下次 `open` 会创建新页面。
6. 异步或复杂操作后再次 `observe` 或 `screenshot`，不要凭旧页面状态继续点。

安全边界:

- 登录、2FA、账号安全、OAuth 授权、支付、改密码或删除账号，必须 `request_owner_help`。
- 日常只允许阅读、滚动、截图、安全导航键和普通链接。按钮、坐标点击、发帖、评论、回复、点赞/投票、关注、收藏、举报、上传、下载和其他账号或页面写操作都禁止。
- 不要把密码、token、cookie、银行卡、验证码等敏感内容写进回复或记忆。

调试和证据:

- browser screenshot 会作为 image block 进入历史；涉及视觉判断时不要只看文本摘要。
- browser artifact 和 action log 留在磁盘，不能从日志重建 prompt history。controller-owned artifact 按配置的数量和保留时长自动清理；清理失败只影响磁盘回收，不改变当前浏览结果。
- 如果页面卡住、元素找不到或状态不一致，先重新 `observe` / `screenshot`，必要时请求 owner help，不要连续盲点。
