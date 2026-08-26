# 仓库 Agent 指令

`AGENTS.md` 和 `CLAUDE.md` 必须保持字节级一致。本文件只放短而稳定的仓库级约束；更细、变化更快的上下文放在 `docs/`。

## 优先阅读

- `docs/README.md`：仓库知识地图。
- `docs/ARCHITECTURE.md`：运行形态、范围路由和模块边界。
- `docs/AGENT_CONTEXT.md`：永续上下文和 replay 不变量。
- `docs/MEMORY_ARCHITECTURE.md`：事实账本、LLM ledger、Memory 与 Notebook 的边界和流程。
- `docs/TOOLS.md`：工具注册、LLM 路径和安全边界。
- `docs/OPERATIONS.md`：命令、Git 格式、验证和日志。
- `docs/TECH_DEBT.md`：已知清理候选。

如果文档和代码冲突，优先相信代码、schema、测试和实际日志。

## Agent skills

### Issue tracker

Issues、PRD 和跨会话 tickets 使用 GitHub Issues，通过 `gh` 操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

使用 Matt Pocock skills 默认的五类 triage 标签。见 `docs/agents/triage-labels.md`。

### Domain docs

采用 multi-context：bot/backend 与 `apps/admin-web` 分别维护领域上下文，由根 `CONTEXT-MAP.md` 路由。见 `docs/agents/domain.md`。

## 工作原则

- 实事求是。遇到不确定的东西，先查代码、schema、测试、日志、文档或当前外部来源。
- 代码是最终事实来源。

### 个人实验项目默认取舍

- 这是单人使用、快速迭代的实验性项目。默认目标是用最小实现尽快跑通端到端流程，而不是达到生产级成熟度；先交付可工作的窄解，等真实需求、故障和数据出现后再扩展。
- 除非用户明确要求，或已有可测量的真实痛点，否则不要主动建设 HA、failover、跨重启自动续跑、多层降级、复杂重试/对账、容量规划、全面 observability、企业权限体系、合规审计或运维平台。清晰失败和简单日志通常优于自动恢复与完整监控体系。
- 默认按单用户、单实例、本地或受控环境设计。优先直接依赖、简单模块和必要的手工操作；不要为假设中的多租户、超大规模、未来插件、通用平台或未知扩展点提前抽象、配置化和分层。
- 允许为了验证想法而保留少量易删除的硬编码、重复代码或临时实现，但边界必须清楚，不得掩盖已知错误。技术债应由真实迭代压力推动处理，不要为了形式上的“完美”扩大改动范围。
- 验证力度与风险相称：优先覆盖关键 happy path、核心不变量和已知回归，不默认追求覆盖率数字、穷举边界矩阵或生产级压测。改动仍需运行最小有用验证，并让失败状态明确、可诊断。
- 对仓库源码、schema 和本地开发数据，除非用户明确要求，否则允许直接做破坏性改动，无需备份、兼容层或历史迁移；优先选择干净的目标模型，不要围绕旧 bridge 或 adapter 设计。
- “实验性”不授权泄露 secret、绕过外部副作用确认、暴露不受控 shell、删除生产或外部服务数据，也不降低核心正确性、确定性 replay 和现有安全边界。生产级安全加固不是默认目标，但基础凭据保护和副作用隔离必须保留。
- 不要把频繁变化的默认值、完整文件地图、模型名或阶段 checklist 写进这里；放到代码、`.env.example`、`package.json`、schema、日志或专题文档。

## 范围路由

- 读文件前先判断任务范围。
- 当前范围包括 bot/backend 和独立的 `apps/admin-web/**` 本机管理面；涉及 WebAdmin 时先读它自己的局部指令，并把修改限制在对应范围。
- 做 bot/backend 任务时，不要读或改无关的 UI/admin 面。

## 核心产品契约

项目主线是永续上下文和渐进式披露。

- `bot_agent_ledger_entries` 是唯一持久 LLM history source；`AgentContext` 是它的当前内存 projection。新的 LLM 可见事实只能通过受控 append 或 compaction 进入。
- `messages` 是入站事实账本，不是 LLM ledger。
- 对外 QQ / 飞书发言必须先用 `conversation open` 显式选择 target，再走 `send_message`；当前 focus 只能来自受控 runtime state。
- compaction 只追加 boundary entry，不更新或删除旧 prefix；projection 解释最新 boundary，并必须保留 assistant tool call 和对应 tool result 的原子性。
- replay 必须确定性。不要从可变 side table 或运维日志重建 prompt history。
- 长内容或可变内容应通过工具、摘要或有边界的文件路径按需披露，不要塞进常驻 prompt。

修改 context、replay、compaction、消息渲染、system prompt 字节、tool description 或图片 handle 契约前，先读 `docs/AGENT_CONTEXT.md`。

## 开发规则

- 项目是 ESM-only，本地 TypeScript import 使用 `.js` 扩展名。
- Prisma client 输出目录是 `src/generated/prisma/`。
- 工具注册集中在 `src/agent/tools/index.ts`；声称某个工具存在前先查这个文件。
- 不要把裸 shell 暴露给常驻 bot。Bash 类工具必须有命令 allowlist、固定 workspace、最小 env、输出/时间上限和审计日志。
- `data/agent-workspace/` 是 bot 自己生产内容的区域，默认不是项目源码。除非用户明确要求，否则不要提交这里的生成物。
- 有副作用的工具要格外谨慎：`send_message`、图片生成/下载、notebook/memory/sticker 工具、browser 写操作，以及未来任何会写 DB 或外部服务的工具。
- WebAdmin 的观察 feature 保持只读；唯一写入口是固定 operations feature，必须经过预览、确认、Bot 停止检查、single-flight runner 和本地审计，禁止通用 shell、SQL、命令名或路径输入。
- Codex、Claude Code 等开发助手在开发期间不得自动启动或重启本项目的真实 Bot/Agent 运行实例；任何启动或重启（包括验证、应用改动或故障恢复）都必须先向用户请求并获得当次明确确认，且执行前检查现有实例，避免并行运行多个实例。
- 除非任务明确需要真实运行，否则不要启动会连接外部服务、QQ/NapCat、浏览器 sidecar、数据库或长期驻留的真实进程；优先使用静态检查、focused test、日志和已有运行证据。
- 确需启动真实进程时，必须用可控方式运行，记录 PID/端口/log，任务结束前主动关闭，并用 `.bot.pid`、`ps`、`lsof` 或相关日志复查确认没有遗留进程。

## Git 和验证

- 默认采用 trunk-based development，直接在主干 `main` 进行开发。
- 提交信息格式：`<type>: <中文描述>`。
- 允许的 type：`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`。
- 改代码时，先跑最小有用测试；影响面大时再跑更广的验证。
- 只改文档时，检查 diff 并运行 `pnpm repo-check`。
- 修改 schema 后运行 `pnpm db:generate`。
- 如果不能验证，明确说跳过了什么以及原因。
