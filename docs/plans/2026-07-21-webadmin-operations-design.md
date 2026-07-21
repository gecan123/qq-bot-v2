# WebAdmin 管理操作设计

## 背景

`apps/admin-web` 当前是只读运维观察面。根 `package.json` 同时提供了四类需要人工执行的状态维护命令：

- `agent:reset-state`
- `agent:migrate-memory-v2`
- `agent:canonicalize-memory`
- `agent:migrate-state-language`

这些命令目前只能从终端使用。目标是在仍然只供本机 operator 使用的前提下，把它们提升为可预览、可确认、可跟踪的 WebAdmin 管理操作。

## 目标

- 为四种固定管理操作提供统一 WebUI。
- 所有写操作先生成只读预览，再明确确认。
- 执行前确认 Bot 已停止，并在预览与执行之间重新校验输入状态。
- 复用 `src/ops/**` 的强类型服务，不从浏览器拼接或执行任意 shell。
- 同一时刻最多执行一个写任务。
- 长时间运行的中文迁移异步执行，页面可以轮询进度。
- 记录操作状态、结果和审计事件，但不把这些数据加入 canonical ledger 或 replay。

## 非目标

- 不在本阶段增加登录、账号、角色或远程访问能力。
- 不开放任意 SQL、shell、package script 或文件路径输入。
- 不把 `db:query`、`tick`、`browser:controller`、开发服务器生命周期放进管理台。
- 不允许 WebAdmin 自动停止或重启 Bot。
- 不把管理任务状态设计成新的 Agent 长期状态。

## 方案选择

### 方案 A：固定白名单子进程

WebAdmin 使用 `execFile` 调用固定 package script。改动小，但 CLI 输出解析、进度报告、测试替身和错误分类都较弱，且容易让脚本参数和 Web DTO 漂移。

### 方案 B：共享强类型运维服务

WebAdmin 和 CLI 共同调用 `src/ops/**`。把 Bot 停止检查、预览和中文迁移计划提取为共享服务。Web 入口只接收 Zod 校验过的 operation union。

这是选定方案。它保持命令行和 WebUI 语义一致，同时避免暴露通用命令执行能力。

### 方案 C：独立运维 daemon

由单独进程持久运行任务队列。它能更好地跨 WebAdmin 重启恢复任务，但对当前本机单用户部署过重，因此不采用。

## 操作模型

管理台只识别以下 operation：

| Operation | 预览 | 执行结果 |
| --- | --- | --- |
| `reset_state` | scope、待删除数据库记录数、待删除知识目录 | 实际删除计数、runtime singleton 重建状态 |
| `migrate_memory_v2` | 文件数、条目数、移动/隔离计划、warning | 备份目录和迁移统计 |
| `canonicalize_memory` | 来源文件、目标文件、条目数 | 备份目录和归并统计 |
| `migrate_state_language` | 待翻译字段分类、条目数和预计批次数 | 备份目录、翻译计数、重命名文件和修复计数 |

Memory v2 和 canonicalize 是一次性维护操作。预览表明已经达到目标结构时，UI 显示“无需执行”并禁用主按钮。

## 用户流程

1. 打开新的“管理操作”页面。
2. 选择 operation；reset 还必须选择 `context`、`knowledge` 或 `all` scope。
3. 请求服务端生成预览。
4. 页面展示影响范围、警告、可恢复性和要求输入的确认短语。
5. operator 输入完全匹配的确认短语。
6. 服务端确认 Bot 已停止，重新生成预览并核对指纹。
7. 预览未漂移时创建 operation run；已漂移时拒绝执行并要求重新预览。
8. 页面轮询 run 状态，直到 `succeeded`、`failed` 或 `interrupted`。

确认短语由服务端 DTO 返回，前端不自行推导。reset 必须在界面上明确说明其没有自动恢复路径；三种迁移展示自动备份目录。

## WebAdmin 页面

侧边栏拆成两个区域：

- “观察面”：保留现有只读页面。
- “管理”：新增“管理操作”。

品牌区域不再把整个应用描述为只读，而是显示“本机管理模式”。观察页仍保持只读，写入口只存在于 management feature。

管理页面包含：

- 四张 operation 卡片及当前是否需要执行。
- preview 详情面板。
- Bot 运行状态与阻塞原因。
- 确认输入和执行按钮。
- 当前任务的阶段、进度、开始时间和安全错误摘要。
- 最近操作记录和备份路径。

## 服务端边界

新增独立 `features/operations`：

- `operations.schema.ts`：跨 server/client 的 discriminated union DTO。
- `operations.server.ts`：预览、启动和查询 run 的 server-only adapter。
- `operations.functions.ts`：固定 GET/POST Server Functions。
- `operations.query.ts`：TanStack Query 轮询配置。
- `OperationsView.tsx`：纯 DTO UI。

浏览器不能提交命令名、脚本参数、工作目录或文件路径。所有路径由服务端从 repository root 和 workspace root 推导。

现有静态边界测试改为：

- Prisma、Node API、环境变量和 server-only 模块仍不得进入 browser source。
- 除 `features/operations/*.server.ts` 外，WebAdmin feature 不得出现数据库 mutation。
- operations server 只能调用经过列举的共享运维服务，不得引入通用 shell 执行。

## 共享运维服务

### Bot 停止检查

把各 CLI 重复的 PID/`ps` 检查提取到 `src/ops/bot-process-guard.ts`。所有四种 Web 操作和相应 CLI 共用同一实现：

- `.bot.pid` 指向存活进程时拒绝。
- PID 文件失效时清理 stale pidfile。
- pidfile 缺失或 stale 后，通过限定的 `ps` 检查当前仓库下的 Bot 进程。
- WebAdmin 只报告阻塞，不发送 signal。

### Reset preview

为 reset 增加只读 preview service。context scope 统计 ledger、checkpoint、runtime 和 Goal 行；knowledge scope 统计四个目标目录。执行仍调用现有事务化 `resetAgentState`。

### 中文迁移 preview

把中文迁移的收集阶段和应用阶段分开。preview 只收集待翻译 item 与类别计数，不创建备份、不修复或写文件。execute 才创建备份、调用 LLM 并应用更新。

### 预览指纹

服务端对 canonicalized preview payload 计算 SHA-256，并生成短期 preview ID。启动执行时重新预览并比较指纹。WebAdmin 重启后 preview ID 失效，operator 必须重新预览。

## 任务运行与状态

WebAdmin Node 进程内维护一个单并发 operation runner：

- `queued`
- `running`
- `succeeded`
- `failed`
- `interrupted`

Server Function 只负责创建任务，不保持长 HTTP 请求。UI 每秒轮询活动任务，结束后退回较低刷新频率。

任务状态以版本化 JSON 原子写入 `logs/admin-operation-state.json`。审计事件追加到 `logs/admin-operations.ndjson`，至少包含 run ID、operation、scope、preview fingerprint、时间、状态、结果摘要和错误 code。日志不记录长期状态正文、LLM 输入、密钥或完整数据库 payload。

WebAdmin 启动时若发现上一个进程留下的 `running`，将其标记为 `interrupted`。迁移底层仍依赖现有备份、CAS、临时目录验证和原子替换保证数据安全；不会尝试盲目续跑。

## 并发和失败处理

- 任意写任务运行时拒绝启动第二个任务。
- preview 可以并发读取，但 execute 前必须重新预览。
- Bot 在 preview 后重新启动时，execute 的第二次 guard 会拒绝。
- 预览指纹变化返回 `preview_stale`，不自动接受新范围。
- LLM、数据库或文件错误只向浏览器返回有界错误摘要；完整结构化错误写本地 app log。
- 操作失败后保留底层已经产生的 backup path，并在结果中显示。
- WebAdmin 或任务进程退出后显示 `interrupted`，由 operator 查看备份和健康检查后决定是否重新运行。

## 本机运行边界

本阶段按明确决策不增加鉴权。开发和 preview 命令继续硬编码绑定 `127.0.0.1:20030`，文档继续禁止公网监听、非受控反向代理和公开部署。

这是本地单用户假设，不代表接口适合远程暴露。未来一旦需要远程访问，必须先增加认证、CSRF 防护和操作主体审计。

## 验证

实现遵循测试先行：

- 共享 Bot process guard 的 live、stale、missing 和 `ps` fallback 测试。
- reset preview 和执行 scope 测试。
- 中文迁移 preview 保证零写入的测试。
- operation runner 的单并发、状态持久化、restart interruption 和错误收敛测试。
- Server Function 输入 schema 和 stale preview 测试。
- OperationsView 的无须执行、阻塞、确认、运行中、成功和失败渲染测试。
- WebAdmin server/client 和 mutation boundary 测试。

最终运行：

```bash
pnpm web:test
pnpm web:typecheck
pnpm web:build
pnpm repo-check
```

共享 `src/ops` 或 CLI 改动影响根项目时，再运行最小相关 root tests，并根据影响面补跑 `pnpm typecheck`。

## 文档同步

实现完成时同步更新：

- 根 `AGENTS.md` 与 `CLAUDE.md`，保持字节级一致。
- `apps/admin-web/AGENTS.md` 与 `apps/admin-web/CLAUDE.md`，保持字节级一致。
- `docs/ARCHITECTURE.md`。
- `docs/OPERATIONS.md`。
- `docs/README.md` 中的 WebAdmin 描述。
