# 项目命令手册

本页统一收录仓库当前可执行命令。根目录命令以根 `package.json` 为事实来源；WebAdmin 专用命令以 `apps/admin-web/package.json` 为事实来源。除非特别说明，命令都在仓库根目录执行。

## 先看风险

- **只读**：读取源码、日志或数据库，不修改业务状态。
- **本地写入**：生成构建产物、Prisma client、测试缓存或日志。
- **真实服务**：可能连接 PostgreSQL、QQ/NapCat、飞书、LLM provider 或真实浏览器。不要并行启动重复实例。
- **破坏性**：修改数据库 schema 或删除 Agent 状态；执行前先停止 Bot 并确认范围。

仓库没有 `stop` 脚本。前台运行时用 `Ctrl-C` 停止 platform supervisor；执行 reset 或 schema 变更前，再用 `.bot.pid`、`ps` 或 `lsof` 确认 Agent Core 已停止。

## 安装与首次启动

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

填写 `.env` 后再启动。`pnpm dev*`、`pnpm start` 和各 sidecar 命令会连接真实服务，不是隔离测试。

## 平台与服务

| 命令 | 类型 | 作用 |
| --- | --- | --- |
| `pnpm dev` | 真实服务 | watch 模式启动 platform supervisor、sidecars 和 Agent Core。源码变化会触发相关进程重启。 |
| `pnpm dev:once` | 真实服务 | 单次启动完整平台，不监听源码变化。 |
| `pnpm dev:all` | 真实服务 | watch 模式启动完整平台，并额外启动本机 WebAdmin。 |
| `pnpm dev:all:once` | 真实服务 | 单次启动完整平台和 WebAdmin。 |
| `pnpm start` | 真实服务 | 从 `dist/` 启动已编译的完整平台；先运行 `pnpm build`。 |
| `pnpm agent:dev` | 真实服务 | watch 模式只启动 Agent Core 兼容入口；需要已经可用的 sidecars。 |
| `pnpm agent:dev:once` | 真实服务 | 单次启动 Agent Core 兼容入口。 |
| `pnpm agent:start` | 真实服务 | 从 `dist/index.js` 启动已编译的 Agent Core 兼容入口。 |
| `pnpm qq:gateway` | 真实服务、数据库写入 | 单独启动 QQ Gateway，连接 NapCat，处理 backfill、入站和 QQ 外发边界。不要与完整 platform 重复启动。 |
| `pnpm feishu:gateway` | 真实服务、数据库写入 | 单独启动飞书 Gateway；只有配置启用且凭据完整时使用。 |
| `pnpm media:worker` | 真实服务、数据库写入、LLM | 单独启动媒体描述 worker，可能调用 LLM 并更新媒体事实。 |
| `pnpm browser:controller` | 真实服务、本地写入 | 在配置的 loopback 端口启动浏览器 sidecar，使用真实 profile 和 artifact 目录。 |

## 构建与验证

| 命令 | 类型 | 作用 |
| --- | --- | --- |
| `pnpm build` | 本地写入 | 删除并重建根 `dist/`，编译 TypeScript。 |
| `pnpm typecheck` | 只读检查 | 运行根 TypeScript `--noEmit` 检查。 |
| `pnpm repo-check` | 只读检查 | 检查仓库指令镜像、文档入口、schema/tool anchors 和已编码的漂移规则。 |
| `pnpm lint` | 只读检查 | 依次运行 `typecheck` 和 `repo-check`。 |
| `pnpm test` | 隔离测试 | 运行全部 `src/**/*.test.ts`；测试环境不读取本机 `.env`。 |

常用完整验证：

```bash
pnpm typecheck
pnpm test
pnpm repo-check
git diff --check
```

只跑一个测试文件时直接使用 Node runner；不要用 `pnpm test -- <file>`，因为根 test script 自带全局 glob：

```bash
node --import tsx --test src/agent/loop-policy.test.ts
```

## WebAdmin

| 命令 | 类型 | 作用 |
| --- | --- | --- |
| `pnpm web:dev` | 本机服务 | 在 `127.0.0.1:20030` 启动 WebAdmin 开发服务器。观察功能只读；固定管理操作仍可按自身预览和确认流程写入。 |
| `pnpm web:test` | 隔离测试 | 运行 WebAdmin Vitest。 |
| `pnpm web:typecheck` | 只读检查 | 检查 WebAdmin TypeScript。 |
| `pnpm web:build` | 本地写入 | 构建 WebAdmin client/server bundle。 |
| `pnpm --filter @qq-bot/admin-web generate-routes` | 本地写入 | 重新生成 TanStack Router route tree。通常由开发流程自动处理。 |
| `pnpm --filter @qq-bot/admin-web preview` | 本机服务 | 在 `127.0.0.1:20030` 预览已构建的 WebAdmin。 |

WebAdmin 常用验证：

```bash
pnpm web:test
pnpm web:typecheck
pnpm web:build
```

## Agent 诊断与观察

| 命令 | 类型 | 作用 |
| --- | --- | --- |
| `pnpm agent:doctor` | 数据库读取；可能真实调用 LLM | 检查必需文件、配置、schema/tool anchors 和 canonical Ledger。默认 provider 为 `claude-code` 时还会执行最多三次 persona-spoof LLM probe，并可能产生观测记录。 |
| `pnpm agent:ledger-check` | 数据库只读 | 完整校验 canonical Ledger、runtime head、compaction 边界和 checkpoint 状态；失败时非零退出。 |
| `pnpm agent:memory-check` | 文件只读 | 检查 `data/agent-workspace` 下 Memory/长期状态格式；可用 `--root PATH` 指定其他根目录。 |
| `pnpm agent:context` | 数据库和文件只读 | 显示当前 working context、token 估算、compaction 阈值和主要 tool-result 占用。 |
| `pnpm agent:metrics` | 日志或数据库只读 | 默认汇总当前 token/tool/app 日志；支持日志路径、DB 数据源和多种过滤条件。 |
| `pnpm agent:daily-metrics` | 日志只读 | 按北京时间输出 1–31 天 token/cache 与工具趋势。 |
| `pnpm bench:ledger-commit` | 本地计算 | 用内存 fixture 比较完整 replay 与增量 commit；默认运行 1 万和 10 万 entry。 |
| `pnpm peek` | 数据库只读 | 格式化查看 canonical Ledger 当前 projection，支持 follow。 |
| `pnpm toollog` | 文件只读 | 查看 `logs/tool-calls.ndjson` 最近 50 行。 |
| `pnpm db:query` | 数据库只读 | 执行单条受限 `SELECT` 或 `WITH ... SELECT`；默认最多 200 行、8 秒和约 8000 字符输出。 |

### Context 报告

```bash
pnpm agent:context
pnpm --silent agent:context -- --json
```

JSON 模式需要保留 `--silent`，否则 pnpm 自身输出会污染机器可读结果。

### Ledger 实时观察

```bash
pnpm peek
pnpm peek -- -n 50
pnpm peek -- -f -n 9999
pnpm peek -- -f --interval 500 --no-color
```

### Metrics

```bash
pnpm agent:metrics
pnpm agent:metrics -- --db
pnpm agent:metrics -- --db --from 2026-08-01 --to 2026-08-27 --tool send_message --ok true
pnpm agent:metrics -- logs/token-usage.ndjson logs/tool-calls.ndjson logs/app.log
pnpm agent:daily-metrics -- --help
pnpm agent:daily-metrics -- --date 2026-08-26 --days 7
pnpm agent:daily-metrics -- --days 7 --compact
```

`agent:metrics` 支持 `--source log|db`、`--from`、`--to`、`--tool`、`--operation`、`--model`、`--ok true|false` 和 `--side-effect true|false`。

### Memory 检查

```bash
pnpm agent:memory-check
pnpm agent:memory-check -- --root data/agent-workspace
```

### Ledger commit 基准

```bash
pnpm bench:ledger-commit
pnpm bench:ledger-commit -- 10000 100000
```

### 受限数据库查询

直接传一条只读 SQL：

```bash
pnpm db:query -- 'SELECT id, entry_type, created_at FROM bot_agent_ledger_entries ORDER BY id DESC LIMIT 10'
```

需要命名参数时传 JSON：

```bash
pnpm db:query -- '{"sql":"SELECT row_id, search_text FROM messages WHERE conversation_external_id = :group_id ORDER BY row_id DESC LIMIT 10","params":{"group_id":672312932}}'
```

该入口拒绝多语句和 `INSERT`、`UPDATE`、`DELETE`、DDL 等写操作。使用 `group_id` 参数时还会校验它是否在当前群策略白名单中。

## Prisma 与数据库维护

| 命令 | 类型 | 作用 |
| --- | --- | --- |
| `pnpm db:generate` | 本地写入 | 根据 `prisma/schema.prisma` 重新生成 `src/generated/prisma/`。修改 schema 或 Prisma 版本后运行。 |
| `pnpm db:migrate` | 破坏性数据库操作、本地写入 | 运行 `prisma migrate dev`，可能修改数据库 schema、创建 migration 并重新生成 client。先停止 Bot，并确认连接的是开发数据库。 |

仓库没有包装 PostgreSQL 整库删除的 package script，也不要把 `agent:reset:all` 当作整库 reset。

## 重置 Agent 状态

所有重置命令都具有破坏性，必须先停止 Bot；如果 `.bot.pid` 对应的进程仍在运行，命令会拒绝执行。

| 想达到的效果 | 命令 | 删除内容 | 保留内容 |
| --- | --- | --- | --- |
| 忘掉旧 LLM 对话和工具调用 | `pnpm agent:reset:context` | canonical Ledger、checkpoint、runtime state、Goal | Memory、Notebook、消息、媒体、表情池、日志 |
| 只清空长期知识 | `pnpm agent:reset:knowledge` | Memory 与 Notebook 目录 | LLM context、消息、媒体、表情池、日志 |
| 清空 Agent context 和 workspace | `pnpm agent:reset:all` | context、Goal、长期知识、草稿、缓存和 runtime 文件 | 消息、媒体、表情池、运维日志 |
| 使用底层通用入口 | `pnpm agent:reset-state -- --scope context|knowledge|all` | 由显式 scope 决定 | 由显式 scope 决定 |

可直接执行：

```bash
pnpm agent:reset:context
pnpm agent:reset:knowledge
pnpm agent:reset:all
```

`context` 会重建 runtime singleton，并保留 mailbox 披露 cursor、inbox 已读 cursor 和 `lastWakeAt` 投递边界，避免保留下来的旧 `messages` 在冷启动后重新变成待回复消息。旧 LLM history、Goal、conversation focus 和 mailbox continuity 仍会清空；下一次冷启动不会把数据库中的既有消息重新拼成旧 prompt history。三个 scope 都不会删除入站 `messages`、`media`、表情池或运维日志；重置完成后也不会自动启动 Bot。

## 命令清单完整性

查看根 package 当前全部脚本：

```bash
node -e "const scripts=require('./package.json').scripts; for (const [name, command] of Object.entries(scripts)) console.log(name.padEnd(24)+' '+command)"
```

查看 WebAdmin package 当前全部脚本：

```bash
node -e "const scripts=require('./apps/admin-web/package.json').scripts; for (const [name, command] of Object.entries(scripts)) console.log(name.padEnd(24)+' '+command)"
```

如果本页与实际脚本冲突，优先相信两个 `package.json` 和当前 CLI 源码，并同步修正文档。
