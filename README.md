# qq-bot-v2

`qq-bot-v2` 是一个基于 NapCat + Node.js + Prisma + PostgreSQL 的 QQ Agent。

它接收 QQ 群聊和私聊消息，把入站事实写入 Postgres，并在单一持久化 `AgentContext` 上运行 `BotLoopAgent`。所有 QQ 消息都按群或联系人形成 mailbox，默认只披露带优先级的有界通知，正文由 Agent 按需读取。

## 核心契约

项目的核心产品契约是稳定、可 replay、低成本扩展的 LLM 历史。

- `bot_agent_ledger_entries` 是唯一持久 LLM history source；`AgentContext` 是其当前内存 projection。
- `messages` 是入站事实账本。它服务于搜索、媒体解析、审计和 replay recovery，但不能替代 `AgentContext`。
- `bot_agent_runtime_state` 保存 mailbox cursors、continuity、Goal revision、active capabilities、QQ 当前会话 focus、last wake 和 ledger head，但不保存或重建 transcript；`bot_agent_checkpoint` 只是可丢弃的 projection cache。
- 新的 LLM 可见事实只能通过受控 append 或 compaction 进入；compaction 把完整待压缩 prefix 交给摘要器，只追加新的 boundary entry，不更新或删除旧历史。
- late media description 和 side table 更新不得改写已经 append 的历史。
- 对外 QQ 发言必须先用 `qq_conversation open` 显式打开 target，再走 `send_message`；新 mailbox 不会自动切换当前会话。
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
- `BOT_TARGET_GROUP_IDS`
- `SELF_NUMBER`
- `LLM_DEFAULT_PROVIDER`
- `LLM_DEFAULT_MODEL`
- `LLM_PROVIDER_<NAME>_URL`
- `LLM_PROVIDER_<NAME>_API_KEY`

## 常用命令

```bash
pnpm dev           # watch 模式启动 bot，文件变化会重启
pnpm dev:once      # 单次启动 bot，不监听文件变化
pnpm build         # 编译 TypeScript
pnpm typecheck     # 只做 TypeScript 检查
pnpm test          # 在隔离的测试环境中运行 src/**/*.test.ts，不读取本机 .env
pnpm repo-check    # 检查仓库指令和文档漂移
pnpm lint          # typecheck + repo-check
pnpm db:generate   # 重新生成 Prisma client
pnpm db:migrate    # 执行 Prisma migrations
pnpm db:push       # 本地开发时同步 schema
pnpm tick          # 通过 SIGUSR1 注入人工调试用 curiosity tick
pnpm toollog       # 查看最近 tool-call 审计日志
pnpm toollogf      # follow tool-call 审计日志
```

## 运行形态

启动流程由 `src/index.ts` 组织：

1. 加载 config、连接 Prisma，并清理过期的 message/media 数据。
2. 注册媒体描述 provider、启动 job queue，创建 Agent LLM client。
3. 校验 canonical ledger/runtime，从 ledger 恢复 `AgentContext` projection，并创建 event queue 和 message-row dedup 路径；checkpoint 只在完全匹配时加速。
4. 注册 NapCat handlers 并连接 NapCat；实时消息从连接成功起即可进入 dedup queue。
5. 等待首次群历史 backfill 的所有来源尝试完成，再读取目标元数据并执行 missed-message replay；单群失败会记录错误，其余来源继续。
6. 构建稳定工具面、system prompt 和 `BotLoopAgent`，随后进入主循环。

`SIGINT` / `SIGTERM` 走幂等的有序退出：先断开 ingress、中止未提交 compaction、请求并等待当前 Agent round 结束、drain backfill、停止 job queue、同步最终 Goal/runtime 状态，最后断开 Prisma。每个阶段都有等待上限，单阶段失败不会跳过后续清理。

主要源码区域：

- `src/agent/**`：永续上下文、主循环、工具、LLM clients、compaction。
- `src/bot/**`：NapCat 入站和消息 ready 流程。
- `src/database/**`：Prisma 访问和入站消息存储。
- `src/media/**`：媒体缓存、描述、handles、出站 promotion。
- `src/messaging/**`：出站发送路径。
- `src/browser/**`：browser sidecar protocol 和 action logs。
- `src/ops/**`：运维日志和仓库检查。

## 开发注意事项

- 项目是 ESM-only，本地 TypeScript imports 使用 `.js` 扩展名。
- Prisma client 输出目录是 `src/generated/prisma/`。
- bot 必须从仓库根目录启动，确保相对路径、logs、prompts 和 `.bot.pid` 一致。
- 生成型 bot workspace 文件位于 `data/agent-workspace/`，默认不是项目源码。
- QQ 号和群号配置必须是正的 JavaScript safe integer；非法值会在启动期直接报错。
- 交回代码前，先跑最小有用测试；影响面大时再跑更广的验证。
