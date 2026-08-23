# qq-bot-v2

`qq-bot-v2` 是一个基于 NapCat + Node.js + Prisma + PostgreSQL 的多进程 QQ Agent。

默认由本机 supervisor 管理 Agent Core、QQ Gateway 和 Media Worker；Feishu Gateway 与 Browser Controller 按配置启用。只有 Agent Core 在单一持久化 `AgentContext` 上运行 `BotLoopAgent`，其他进程通过 PostgreSQL 事实边界或薄 HTTP 协作，不拥有 canonical ledger。短期调度作为 Agent Core 内部深模块运行，Agent Core 与 Media Worker 直接调用配置的 LLM provider。所有 QQ 消息都按群或联系人形成 mailbox，默认只披露带优先级的有界通知，正文由 Agent 按需读取。

仓库还包含 `apps/admin-web`：一个独立的 localhost-only WebAdmin。它提供当前活动、Context/Ledger、Timeline、长期状态、跨平台 Conversations/Media、Metrics、Quick Health/手动 Deep Integrity、进程日志，以及唯一受控的 `reset_state` 操作；它不改变 bot/backend 主线，也不是新的事实或 replay 来源。

## 核心契约

项目的核心产品契约是稳定、可 replay、低成本扩展的 LLM 历史。

- `bot_agent_ledger_entries` 是唯一持久 LLM history source；`AgentContext` 是其当前内存 projection。
- `messages` 是入站事实账本。它服务于搜索、媒体解析、审计和 replay recovery，但不能替代 `AgentContext`。
- `bot_agent_runtime_state` 保存 mailbox cursors、continuity、Goal revision、active capabilities、跨平台 conversation focus、last wake 和 ledger head，但不保存或重建 transcript；`bot_agent_checkpoint` 只是可丢弃的 projection cache。
- 新的 LLM 可见事实只能通过受控 append 或 compaction 进入；compaction 把完整待压缩 prefix 交给摘要器，只追加新的 boundary entry，不更新或删除旧历史。
- late media description 和 side table 更新不得改写已经 append 的历史。
- 对外 QQ / 飞书发言必须先用 `conversation open` 显式打开 target，再走 `send_message`；新 mailbox 不会自动切换当前会话。
- 工具日志和其它 `logs/*.ndjson` 是运维旁路，不是 prompt replay 输入。

详细不变量见 `docs/AGENT_CONTEXT.md`。

## 文档地图

- `AGENTS.md` / `CLAUDE.md`：稳定的仓库级 agent 指令。
- `docs/README.md`：更细文档的知识地图。
- `docs/ARCHITECTURE.md`：运行形态和模块地图。
- `docs/AGENT_CONTEXT.md`：永续上下文和 replay 规则。
- `docs/TOOLS.md`：工具注册和安全边界。
- `docs/OPERATIONS.md`：命令、日志和验证。
- `.env.example`：当前环境变量示例。
- `package.json`：当前脚本和依赖。
- `prisma/schema.prisma`：数据库契约。

## 环境要求

- Node.js 20+
- pnpm 10+
- PostgreSQL
- 开启 WebSocket 的 NapCat
- OpenAI-compatible LLM endpoint，或本地兼容网关

## 启动

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

启动前先填写 `.env`。最少需要配置：

- `DATABASE_URL`
- `NAPCAT_WS_URL`
- `NAPCAT_ACCESS_TOKEN`
- `SELF_NUMBER`
- `LLM_DEFAULT_PROVIDER`
- `LLM_DEFAULT_MODEL`
- `LLM_PROVIDER_<NAME>_URL`
- `LLM_PROVIDER_<NAME>_API_KEY`

群监听范围、主动发送权限和参与节奏统一维护在 `prompts/groups.md`；没有群 section 时只接受好友私聊。

## 常用命令

```bash
pnpm dev           # watch 模式启动多进程平台
pnpm dev:once      # 单次启动多进程平台
pnpm dev:all       # watch 模式启动多进程平台与 WebAdmin
pnpm dev:all:once  # 单次启动多进程平台与 WebAdmin
pnpm agent:dev     # watch 模式启动旧单进程兼容入口
pnpm agent:dev:once # 单次启动旧单进程兼容入口
pnpm build         # 编译 TypeScript
pnpm typecheck     # 只做 TypeScript 检查
pnpm test          # 在隔离的测试环境中运行 src/**/*.test.ts，不读取本机 .env
pnpm repo-check    # 检查仓库指令和文档漂移
pnpm bench:ledger-commit # 1 万/10 万 permanent entry full replay 与真实 coordinator commit 基准
pnpm lint          # typecheck + repo-check
pnpm web:dev       # 在 127.0.0.1:20030 启动只读 WebAdmin
pnpm web:test      # 运行 WebAdmin Vitest 测试
pnpm web:typecheck # 检查 WebAdmin TypeScript
pnpm web:build     # 构建 WebAdmin client 和 server bundle
pnpm db:generate   # 重新生成 Prisma client
pnpm db:migrate    # 执行 Prisma migrations
pnpm toollog       # 查看最近 tool-call 审计日志
pnpm peek -- -f -n 9999 # follow canonical Agent ledger
```

## 只读 WebAdmin

WebAdmin 使用 TanStack Start、React、TanStack Router/Query、Tailwind CSS 4 和 Zod。浏览器只调用同源 Server Function；服务端再通过只读 query service 查询 Postgres，并返回已校验、已序列化的 DTO：

```text
Browser → TanStack Start Server Function → read service → PostgreSQL
```

运行前把 `apps/admin-web/.env.example` 复制为不提交的 `apps/admin-web/.env.local`，配置 `DATABASE_URL`，并先运行 `pnpm db:generate`。默认只绑定 `127.0.0.1:20030`。当前没有管理员鉴权，不得改为非可信网络监听或直接公开部署。

WebAdmin 的观察 feature 不能更新或删除 ledger、runtime state、checkpoint、Goal、消息、媒体或 workspace side-data，也不能用页面缓存或查询结果重建 `AgentContext`。唯一写入口是带预览、确认、停机检查、single-flight 和审计的固定 `reset_state` operation；不接受通用 shell、SQL、命令名或路径输入。

## 运行形态

平台启动由 `src/platform.ts` 组织，并先等待各 sidecar 健康，再启动 `src/index.ts` 中的 Agent Core：

1. QQ Gateway 独占 NapCat WebSocket、首次历史 backfill、好友/群查询和 QQ 外发；按配置启用的 Feishu Gateway 独占官方 WebSocket、媒体下载和飞书外发；各自 ready 后才通过健康屏障。
2. Media Worker 处理媒体描述并直接调用媒体 provider；每个进程写入 `logs/processes/<name>.log`。
3. Agent Core 获取 PostgreSQL advisory lock 后连接 Prisma，校验 canonical ledger/runtime，从 ledger 恢复 `AgentContext` projection，恢复进程内短期 schedule 与未确认 delivery，并执行 missed-message replay；checkpoint 只在完全匹配时复用。
4. Agent Core 从 backfill 完成后的消息 high-water 启动 database mailbox watcher，通过递增 `messages.rowId` 接收 QQ / 飞书新入站事实。
5. Agent Core 构建稳定工具面、system prompt 和唯一 `BotLoopAgent`，随后进入主循环。

`SIGINT` / `SIGTERM` 由 supervisor 转发给全部子进程。各进程只清理自己拥有的连接、timer、HTTP server 和数据库资源；Agent Core 仍按顺序停止 mailbox watcher、当前 Agent round 和内部 jobs，保存最终状态后断开 Prisma。

主要源码区域：

- `src/agent/**`：永续上下文、主循环、工具、LLM clients、compaction。
- `src/bot/**`：NapCat 入站和消息 ready 流程。
- `src/database/**`：Prisma 访问和入站消息存储。
- `src/media/**`：媒体缓存、描述、handles、出站 promotion。
- `src/messaging/**`：出站发送路径。
- `src/services/**`：QQ、飞书和媒体等需要独立连接或慢任务所有权的窄服务边界。
- `src/platform.ts`：本机进程生命周期、健康屏障和独立日志。
- `src/browser/**`：browser sidecar protocol 和 action logs。
- `src/ops/**`：运维日志和仓库检查。
- `apps/admin-web/**`：独立只读 WebAdmin；数据库访问仅位于 server-only 边界。

## 开发注意事项

- 项目是 ESM-only，本地 TypeScript imports 使用 `.js` 扩展名。
- Prisma client 输出目录是 `src/generated/prisma/`。
- bot 必须从仓库根目录启动，确保相对路径、logs、prompts 和 `.bot.pid` 一致。
- 生成型 bot workspace 文件位于 `data/agent-workspace/`，默认不是项目源码。
- QQ 号和群号配置必须是正的 JavaScript safe integer；非法值会在启动期直接报错。
- 交回代码前，先跑最小有用测试；影响面大时再跑更广的验证。
