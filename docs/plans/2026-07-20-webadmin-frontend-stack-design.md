# WebAdmin 前端技术栈设计

## 背景

`qq-bot-v2` 当前以 bot/backend 为主，没有在役的管理 WebUI。仓库已经具备可支撑管理台的主要事实源和只读分析能力：QQ `messages` / `media` 事实账本、append-only `bot_agent_ledger_entries`、runtime/checkpoint/Goal 控制状态、`agent_tool_calls`、`agent_token_usage`，以及 `agent:context`、`agent:metrics` 等运维报告。

本轮希望借鉴 Kagami WebAdmin 的观察面和交互模式，同时把新管理台作为较新前端技术栈的受控试验田。试验必须隔离在 WebAdmin 边界内，不能改变主 Agent 的 canonical history、replay、compaction 或副作用契约。

## 目标

- 为内部运维提供数据密集、可深链接、移动端可用的管理界面。
- 优先呈现主 Agent 上下文、ledger、工具/Token 指标、QQ 消息与媒体、Goal 和调度状态。
- 采用较新的全栈 React 技术，验证类型安全路由、URL 状态和 server function 工作流。
- 保持 WebAdmin 可独立演进、升级或移除，不把框架依赖扩散进 bot/runtime。

## 非目标

- 第一阶段不提供 `compact`、wake、发送 QQ 消息、触发调度或直接修改长期状态等写操作。
- 不从 WebAdmin 更新或删除 ledger entry、runtime state、checkpoint 或 Goal 表。
- 不把日志、checkpoint、side-data 或管理台缓存提升为新的 replay/事实来源。
- 不复活旧 Admin Web 的 per-scene runtime、reading session、opportunity 等已退役模型。
- 不为管理台引入 Kagami 的多卫星服务、DuckDB metric 或独立 OSS 拓扑。

## 技术选择

采用以下栈，并锁定精确版本：

- TanStack Start（React，当前 RC）
- React 19
- TanStack Router
- TanStack Query
- TanStack Table
- Tailwind CSS 4
- Radix UI 行为基元；可按需使用 shadcn/ui 源码组件
- Zod 作为输入、URL search params 和响应边界校验
- Apache ECharts 作为时间序列与聚合图表层
- Vitest 用于纯逻辑和组件测试
- Playwright 用于关键管理台流程

选择 TanStack Start 的主要理由：

1. Router 对 path/search params 提供一等类型安全，适合管理台大量筛选、分页和可分享深链接。
2. Server Functions / Server Routes 能把数据库、环境变量、鉴权和后续 runtime 命令留在服务端边界。
3. 与 TanStack Query/Table 组合后，轮询、保留上一帧、列表详情和大表格路径清晰。
4. 继续使用 React 生态，可以借鉴 Kagami 的页面结构，而不复制其部署拓扑。
5. WebAdmin 是隔离的新 surface，适合承受 RC 框架的受控升级成本。

React Router Framework Mode 是稳定性优先的回退方案；SvelteKit + Svelte 5 虽然学习价值高，但会同时引入新的组件模型和生态分叉，不作为本次首选。

## 目录与依赖边界

管理台放在 `apps/admin-web/`，并恢复 pnpm workspace 对该 app 的显式管理。该目录应有自己的局部 `AGENTS.md` / `CLAUDE.md`，且二者保持字节级一致。

建议结构：

```text
apps/admin-web/
├── app/
│   ├── routes/              # TanStack Router 路由模块
│   ├── components/          # 页面与共享组件
│   ├── features/            # context、metrics、messages 等垂直切片
│   ├── server/              # server functions/routes 和只读查询适配
│   └── lib/                 # query keys、格式化、schema 等
├── public/
├── tests/
└── package.json
```

WebAdmin 可以复用仓库内纯类型、Zod schema 和无副作用的报告构建器，但不能从前端 bundle 导入 Prisma、bot runtime 或带 secret 的 config。任何 server-only import 都必须位于明确的 server 模块中，并有构建检查防止进入客户端产物。

## 运行架构

第一阶段以一个独立 TanStack Start Node 服务运行：

```text
Browser
  │ same-origin HTTP
  ▼
TanStack Start WebAdmin
  ├── 页面、Router、Query、Table、Charts
  └── Server Functions / Server Routes
        ├── 只读 Postgres 查询
        ├── 调用 context/metrics 只读报告模块
        └── 返回经过 Zod 校验和脱敏的 DTO
```

初始部署只绑定 loopback，面向本机或受控反向代理使用。公网访问、多人账号和远程管理员鉴权不属于第一阶段；在这些能力落地前不得把服务直接暴露到非可信网络。

数据库访问使用只读查询模块，不允许页面或通用组件直接使用 Prisma。即使数据库账号暂时仍有写权限，应用层导出的管理台接口也必须保持查询-only。

## 第一阶段信息架构

### 1. 总览

- bot/runtime 最近活动时间和可用性。
- 当前 Goal、QQ focus、最近 wake。
- token/cache、工具调用与失败摘要。
- 最新 compaction、checkpoint 状态和告警。

### 2. Context 与 Ledger

- 当前 canonical projection 和有界消息预览。
- ledger head、entry 类型时间线和最新 compaction boundary。
- canonical/working message 数、图片 hydrate/omit/unavailable 数。
- context token 使用率、距 compaction trigger 的余量。
- token 分类及主要 tool-result contributor。
- runtime state 与 checkpoint 一致性信息。

该页面只读取 canonical ledger 并复用现有确定性 projection/report 逻辑，不能自行解释或重建另一套历史。

### 3. 工具与 Token 指标

- 按时间范围、模型、operation、tool、成功/失败、副作用筛选。
- input/cached/output token 与 cache hit rate 趋势。
- 工具调用量、失败率、平均/P95/P99 耗时。
- compaction、Life review、memory maintenance 等 operation 分布。

时间桶聚合应在 Postgres 查询层完成，不把无限原始行拉到浏览器或 Node 内存后再聚合。

### 4. QQ 消息与媒体

- 按 scene、群/好友、发送人、昵称、关键词和时间查询。
- 展示 resolved text、结构化 content、raw content 和媒体引用。
- Media 展示 MIME、大小、hash、描述状态、引用消息和有界缩略图。
- 二进制响应设置严格 MIME、`nosniff`、下载/预览策略和大小上限。

### 5. Runtime 状态

- Goal 状态、预算、进度、blocker 和 revision。
- schedules、mailbox cursors/continuity、active capabilities、QQ focus。
- 后台 task 概览和最近错误（仅展示已有稳定观测数据）。

## 数据与交互约定

- 列表筛选、页码、排序和选中项尽量进入 URL search params。
- 服务端对分页、时间范围和返回体大小设硬上限。
- TanStack Query 查询键必须包含全部筛选条件；分页切换保留上一帧数据。
- 实时页使用有界轮询。轮询失败时保留最后一帧成功数据并明确显示 stale/error 状态。
- 页面只消费显式 DTO，不直接把 Prisma row 或 BigInt 传给客户端。
- 时间统一传 ISO 8601，前端按用户时区展示。
- 所有原始 JSON、日志和 tool args 在服务端脱敏、裁剪后再返回。

## 错误与安全边界

- 查询失败返回稳定错误 code 和安全文案；完整异常只进入服务端日志。
- WebAdmin 不得泄露 API key、Authorization header、cookie、OAuth token、数据库连接串或任意环境变量。
- LLM/system prompt、tool args、QQ 消息和媒体均视为敏感数据；默认截断，详情按需加载。
- 第一阶段不创建通用 SQL、文件浏览或 shell API。
- 未来增加写操作时，必须引入管理员鉴权、CSRF 防护、二次确认、审计记录和 runtime command adapter；命令必须由 Bot Runtime 执行，不能直接写控制表。

## 测试与验证

- Zod schema、URL search params、分页、时间桶、脱敏和截断逻辑使用 Vitest。
- Server Functions 使用注入的只读 query port 测试成功、空数据、超时和坏数据边界。
- Context 页面以 canonical ledger fixture 验证 projection、compaction boundary 和 tool pair 原子性。
- Playwright 覆盖总览加载、筛选深链接、分页、列表详情、轮询失败保留旧快照和移动端详情返回。
- 构建检查确认 server-only 模块没有进入浏览器 bundle。
- 完成阶段运行 WebAdmin 自身 build/typecheck/test，并按仓库要求运行 `pnpm repo-check`。

## RC 风险控制

- TanStack Start、Router 及相关构建依赖使用精确版本，不使用 `^` 或 `latest`。
- 框架升级单独提交，阅读 release notes 后执行完整 WebAdmin 验证。
- 业务查询与页面组件不直接依赖底层 server-function 实现，保留换回 React Router Framework Mode 的可能。
- 不在第一阶段同时试验另一套状态管理、CSS-in-JS 或数据库框架，控制变量。

## 分阶段交付

1. 脚手架、局部指令、健康页、测试与构建门禁。
2. 只读 server 边界、总览和 Context/Ledger。
3. 工具与 Token 趋势。
4. QQ 消息与媒体。
5. Runtime 状态和整体安全审计。
6. 另行设计并批准后，才评估任何写操作和远程鉴权。
