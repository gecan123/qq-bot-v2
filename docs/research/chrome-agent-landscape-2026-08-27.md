# Chrome / Browser Agent 标准与工具版图（2026-08-27）

> 调研日期：2026-08-27。本文只采用正式规范、厂商官方文档或官方源码仓库；版本、产品能力和支持范围以该日期页面为准。

## 结论先行

1. **目前没有统一的“Browser Agent 标准”。**真正的浏览器远程控制标准是 W3C WebDriver；双向事件与控制的 WebDriver BiDi 截至本文日期仍是 Working Draft。Chromium 生态里更常用的是 CDP，但它是 Chrome/Chromium 的事实接口，不是跨浏览器标准。
2. **MCP 是 Agent 与外部工具之间的通用接入协议，不规定浏览器怎样观察、定位和点击。**Playwright MCP 与 Chrome DevTools MCP 都使用 MCP，但 tool 名、页面快照、元素引用和生命周期并不互通。
3. **Accessibility tree（AX tree）是当前文本模型控制网页最常见、最实用的观察层，但不是统一的 Agent 协议。**各工具都会把它重新序列化，并自行生成短期 `ref`/`uid`。CDP 的 Accessibility domain 本身仍标为 Experimental。
4. **没有多模态不等于不能控制 Chrome。**Playwright MCP 默认就使用结构化 accessibility snapshot，明确不依赖截图或视觉模型；Claude 的 Browser Use API 也优先用 `read_page` 产生的元素引用。截图主要用于 canvas、视频、布局判断、纯视觉控件、跨域 iframe、远程桌面和结构树失效时的回退。
5. 对本仓库这种 **Node/TypeScript、单主 Agent、强调确定性 ledger/replay 和窄工具边界** 的系统，首选不是再引入一个 Browser Agent，而是以 **Playwright Library** 做执行层，向主 Agent 暴露少量稳定工具。若要最快验证，可先把 **Playwright MCP** 当独立 sidecar 做 A/B 试验；Chrome 网络、Console、性能诊断才优先选 **Chrome DevTools MCP**。

## 一、哪些算“标准”

### 1. WebDriver / WebDriver BiDi：正式标准层

[W3C WebDriver](https://www.w3.org/TR/webdriver/) 是平台和语言中立的浏览器远程控制协议，也是这一领域最接近“正式标准”的接口。传统 WebDriver 偏请求—响应；[WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/) 增加双向事件和更实时的观察能力，但截至 2026-08-25 的页面仍是 W3C Working Draft。

### 2. CDP：Chromium 的事实接口

[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) 直接暴露 DOM、网络、Console、调试、性能、页面截图和 Accessibility 等 Chrome 能力。协议定义来自 Chromium 源码，浏览器可通过 WebSocket 调试端点提供协议。它能力深、生态成熟，但与 Chrome/Chromium 绑定；不能把它称为跨浏览器标准。

[CDP Accessibility domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/) 能获取完整或部分 AX tree，并在 domain 启用期间维护 AX node ID。该 domain 在官方文档中仍标为 Experimental，因此“AX tree 很常用”与“AX 是稳定统一协议”是两回事。

### 3. MCP：接入标准，不是浏览器动作标准

[MCP 2026-07-28 latest specification](https://modelcontextprotocol.io/specification/latest) 和其[架构说明](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)定义了 host、client、server、tools/resources/prompts、JSON-RPC 以及 STDIO/Streamable HTTP 等连接方式。它解决的是“模型应用怎样发现并调用外部能力”，不解决“网页怎样生成快照、ref 何时失效、click 应该接收 selector 还是坐标”。

因此可以说 MCP 已成为 Agent 工具接入的事实标准之一，但不能说已经存在标准化的 Browser MCP tool schema。

### 4. WebMCP：网页主动暴露工具的草案，不是浏览器控制标准

[WebMCP Draft Community Group Report（2026-08-26）](https://webmachinelearning.github.io/webmcp/)允许网页通过 JavaScript API 或表单把结构化工具暴露给 Agent。其页面明确声明它既不是 W3C Standard，也不在 W3C Standards Track 上。它补充的是“网站提供 Agent 友好能力”，不是通用的 Chrome 导航、标签页、截图、网络或坐标控制协议。

## 二、Codex 与 Claude Code 实际怎么做

### OpenAI Codex / ChatGPT

OpenAI 需要按产品形态区分：

- [OpenAI Browser 官方页面](https://learn.chatgpt.com/docs/browser)明确写明，内建 Browser 可用于 ChatGPT web/desktop，但**不在 Codex CLI 或 IDE 扩展中提供**。桌面端可操作隔离浏览器；安装浏览器扩展后，也能连接用户已有 Chrome profile 和登录态。
- Codex CLI/IDE 的正式扩展路径是 [MCP](https://learn.chatgpt.com/docs/extend/mcp)：支持 STDIO 和 Streamable HTTP，并共享 `~/.codex/config.toml` / 项目 `.codex/config.toml` 配置。因此 Playwright MCP、Chrome DevTools MCP 属于“Codex 接外部浏览器工具”，不是 Codex CLI 自带 Chrome 引擎。
- OpenAI API 的 [`computer` tool](https://developers.openai.com/api/docs/guides/tools-computer-use)是视觉 computer-use 路径：模型读取截图、返回鼠标键盘动作，再接收新截图。官方也允许自建 Playwright/Selenium/VNC/MCP harness，并指出代码执行/DOM 查询可与视觉动作组合。它是像素级通用计算机控制，不能与结构化 Browser MCP 混为一谈。

OpenAI 没有在这些页面公开 ChatGPT desktop 内建 Browser 的底层是否采用 Playwright/CDP，因此不能据外观推断实现细节。

### Anthropic Claude Code / Claude API

- [Claude Code with Chrome 官方文档](https://code.claude.com/docs/en/chrome)描述的是 **Claude in Chrome 扩展 + 本机 native messaging host + `claude-in-chrome` MCP server**。Claude Code 可读取页面、文本、Console、网络和截图，也可点击、输入、导航、管理标签页。这是产品集成，不等于 Anthropic API 的 computer-use tool。
- [Claude in Chrome 权限说明](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)列出了 `scripting`、`debugger`、tabs、nativeMessaging 等扩展权限，说明其能观察 DOM/Console/网络并执行浏览器动作。
- Anthropic API 另有 [`browser_toolset_20260801`](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)：它只是 client tool schema，执行器必须由应用运行。其设计同时支持结构化 accessibility/元素引用和截图/坐标；官方建议网页优先使用 `read_page` 返回的 `ref`，canvas、视频、虚拟化内容或结构树不足时再用截图与坐标。
- [`computer_toolset_20260801`](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)面向整个桌面的截图、鼠标和键盘控制；网页场景官方更建议 Browser Use。两者都要求隔离环境、域名限制和高风险操作的人类确认。

## 三、可直接接入的工具比较

| 工具 | 形态 / 底层 | 文本模型能否用 | Node/TS 接入 | 最适合 | 主要边界 |
|---|---|---:|---:|---|---|
| [Playwright Library](https://playwright.dev/docs/intro) | Library；Chromium/Firefox/WebKit | 是；role/label/text locator、ARIA snapshot | **原生** | 自己定义稳定、窄的 browser tools | 只负责自动化，不提供 Agent loop；`connectOverCDP` 仅 Chromium 且官方提示低于 Playwright protocol 的 fidelity |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | MCP server；Playwright | **是，默认 AX snapshot + ref，不需视觉** | Node sidecar；也提供 programmatic connection | 通用 Agent 快速接入、跨浏览器操作 | 工具与快照会占上下文；vision capability 才开放坐标动作；官方明确它不是安全边界 |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | MCP/实验性 CLI；Puppeteer + CDP | 是；结构化页面快照/UID，截图可选 | Node sidecar | Chrome 调试、Console、网络、性能 trace | Chrome 专用、权限较深、工具面更大；不适合作为最小跨浏览器抽象 |
| [Browser Use](https://github.com/browser-use/browser-use) | Python Agent framework / CLI / Cloud；CDP | 是；DOM/AX 优先，视觉可选 | **非原生 TS**，通常子进程、服务或 MCP | 希望把规划和浏览器自治整体外包 | 会形成第二套 Agent/模型循环、成本和状态；与主 ledger/replay 边界更难对齐 |
| [Stagehand](https://github.com/browserbase/stagehand) | AI-native SDK；本地 Chrome 或 Browserbase/CDP | DOM mode 可用；hybrid/CUA 视觉路径需要图像能力 | **原生 TS** | 用 `act/observe/extract` 做高层 AI 自动化 | 高层操作会发生嵌套 LLM 调用；比直接 Playwright ref 更难做到透明、确定性的 replay |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | CLI + coding-agent skill；Rust/CDP | 是；AX ref 为主、截图可选 | 子进程，不是常规 in-process TS SDK | Codex/Claude Code 式命令行浏览器操作 | 需要自行治理进程、输出契约和 session；更像编码 Agent 工具，不是应用内浏览器模块 |

补充几点：

- [Playwright locator](https://playwright.dev/docs/locators)有 auto-wait/retry，官方优先推荐 role、label、text 等用户可感知定位；[ARIA snapshot](https://playwright.dev/docs/aria-snapshots)可直接得到结构化 YAML。这是文本模型可稳定操作网页的关键，不依赖“把每张图先描述成文字”。
- Playwright MCP README 明确说默认结构化快照优于 screenshot-only 路径，截图本身不作为默认动作来源；只有启用 `vision` capability 时才使用坐标工具。它同时支持 persistent profile、隔离 profile、CDP endpoint 和连接现有标签页的扩展模式。
- [Chrome DevTools MCP 官方入门](https://developer.chrome.com/docs/devtools/agents/get-started)同时给出 Claude Code 和 Codex CLI 配置，但它的优势是 DevTools 级排障，而非“更标准”。
- Browser Use 是完整 Python Agent framework；Stagehand 是可嵌入 TypeScript 的 AI automation SDK。二者都比 Playwright Library/MCP 多承担了一层决策，因此不能只按“浏览器操控更聪明”比较，还要计算嵌套模型、日志归属和失败恢复成本。

## 四、对纯文本模型的判断

纯文本模型能稳定覆盖以下网页任务：

- 读取可访问文本、标题、链接、表单、按钮和页面结构；
- 按 AX `ref`、role/name、label 或稳定 locator 点击和输入；
- 标签页、导航、下载、Console/网络日志等非视觉操作；
- 在结构变化后重新读取页面并获取新 ref。

它会在以下场景明显受限：

- canvas、地图、图表、视频帧、图像验证码；
- 只有颜色/空间关系表达含义的界面；
- 跨域 iframe、远程桌面、结构树不可见的自绘组件；
- 必须判断像素级布局、遮挡、拖拽落点或视觉结果。

成熟方案普遍采用 **semantic-first, vision-fallback**：先读 AX/可见文本和元素 ref；结构信息不足时才截图并交给多模态模型。若主模型没有视觉能力，可以把 `screenshot` 结果路由给独立的视觉检查工具/模型，再把结构化结论返回主 Agent，而不必把整个 browser loop 改成视觉 computer use。

## 五、当前实现并不差，主要短板在观察层

当前仓库不是“把截图全部描述出来再猜坐标”的纯视觉方案：

- [`browser` tool](../../src/agent/tools/browser.ts) 已经把浏览器放在独立 sidecar，使用 headed CloakBrowser persistent profile，并明确要求阅读优先 `read`、交互前先 `observe` 取 `elementId`、只有视觉判断才 `screenshot`；同时保留 read-only、owner help、下载和登录风险边界。
- [`observe`](../../src/browser/controller.ts) 会枚举可交互 DOM 节点，为它们注入短期 `el_N`，后续 `click` / `type` 按该 ID 定位；[`read`](../../src/browser/controller.ts) 则从 `main` 或 document 的 `innerText` 返回有界、可分页文本。这个 **semantic-first、image-fallback** 方向与 Playwright MCP、Chrome DevTools MCP 的主流模式一致。
- `screenshot` 会保存 artifact，并在可压缩时从工具返回真实 image content block；随后 durable message 会把它保存成 `image_ref`。当前未提交实现默认 `LLM_AGENT_IMAGE_MODE=description`，因此主模型的下一轮只拿到持久描述或 marker，只有 `native` 模式才重新解析原图。纯文本模型仍可完成 `read` / `observe` / ref 操作。

相比成熟实现，目前更影响成功率的是以下差距，而不是“主模型必须多模态”：

1. `observe` 是 `document.querySelectorAll` 加手写 role/label 规则，并限制前 30 个可见交互元素；它不等于完整 accessibility snapshot，对 iframe、shadow DOM、大量虚拟化节点和复杂 ARIA 关系更脆弱。
2. `el_N` 只保存在最近一次观察结果里，没有显式绑定 page revision，也没有 stale-ref 自动重读和重定位契约；动态页面更新后容易点错或失败。
3. 当前动作集和诊断面较窄：没有成熟框架常见的条件等待、select/hover/drag/dialog/upload，也没有 Console、network、performance 快照。
4. 截图 fallback 需要精确模型支持图像输入；对纯文本模型，仓库还需要把视觉检查明确路由给独立的视觉工具/模型，而不是假设图片会自动变成可靠文字。尤其是当前 `toDurableAgentMessage()` 在 tool text JSON 没有 `description` 字段时，会把整段 text 当作 fallback description；而 browser screenshot 的 text 只是 URL、artifact 和 base64-omitted 等结果元数据，并不是视觉描述。现有 `description` mode 解决了“不把图片发给文本模型”，尚未解决“让文本模型理解截图”。

因此，评价应是：**架构方向正确、权限边界比通用框架更贴合本项目，但观察层和恢复机制仍是自制的早期版本。**把观察格式升级为 AX-first、给 ref 加 revision/失效语义、复用 Playwright auto-wait，并按需补视觉子工具，会比直接替换成另一个完整 Browser Agent 更划算。

## 六、对 qq-bot-v2 的建议顺序

当前 [`docs/HARNESS_COMPARISON.md`](../HARNESS_COMPARISON.md)明确记录：仓库曾删除未使用的 MCP manager、tool、配置和 SDK 依赖，因为当时没有真实连接需求。因此不应为了“业界都用 MCP”先重建通用 MCP runtime；MCP 是 transport seam，不会自动改善元素定位、ref 生命周期或 replay。

建议按下面顺序：

1. **长期默认：Playwright Library + 自有窄工具契约。**保留单主 Agent，只把 Playwright 当执行层。可参考 Playwright MCP/Anthropic Browser Use 收敛为 `navigate`、`read_page`、`find`、`click(ref)`、`input(ref,text)`、`tabs`、`screenshot`。`ref` 必须绑定 tab/page revision，导航或显著 DOM 更新后失效；tool result 持久保存结构化事实，不能在 replay 时重新读取活动页面。
2. **最快试验：独立运行 Playwright MCP，只接最小工具集。**先不要启用 `vision` capability，用纯文本模型跑 10 个代表性任务，比较成功率、平均回合、上下文 token、ref 失效恢复和登录态隔离。证明有价值后，再决定是否补一个窄 MCP client，而不是一次恢复通用插件平台。
3. **若核心需求是排障：Chrome DevTools MCP。**当任务重点是 Console、请求失败、性能 trace、页面内部状态时，它比 Playwright MCP 更合适；普通网页交互不必承受全部 DevTools 能力面。
4. **若明确要把浏览规划外包：Stagehand 优先于 Browser Use。**Stagehand 对 Node/TypeScript 直接；Browser Use 更适合 Python 服务/Cloud。两者都应被视为专用 worker，并明确记录内部模型调用和最终浏览器事实，避免成为绕过 canonical ledger 的第二条不透明控制流。
5. **不要把 Codex Browser 或 Claude in Chrome 当可嵌入 SDK。**它们是各自产品中的扩展/宿主集成；可借鉴架构，但 qq-bot-v2 真正可直接采用的是 Playwright、MCP server、CLI 或 SDK。

最终判断：如果当前实现已经能提供页面结构、稳定元素引用、点击/输入和明确的失效重读机制，那么它的方向并不落后；最值得补的通常是 **AX-first 的观察格式、短期 ref 契约、Playwright 的 auto-wait，以及有边界的视觉 fallback**。只有“每次都把整张截图描述成长文本，再让主模型猜坐标”才明显落后于当前成熟方案。
