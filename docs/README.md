# Agent 知识地图

这个目录是仓库的 agent 知识库。`AGENTS.md` 和 `CLAUDE.md` 保持短而稳定；更细、更容易变化的上下文放在这里。

## 入口

- `docs/ARCHITECTURE.md`：运行形态、模块边界和启动流程。
- `docs/AGENT_CONTEXT.md`：永续上下文不变量和 replay 规则。
- `docs/MEMORY_ARCHITECTURE.md`：事实账本、LLM ledger、长期记忆、Notebook、Life Journal 和 Agenda 的边界与流程。
- `docs/TOOLS.md`：bot 工具注册、安全边界和外部能力。
- `docs/HARNESS_COMPARISON.md`：按 `learn-claude-code` 章节对照当前 Agent harness 能力。
- `docs/OPERATIONS.md`：本地命令、日志、验证和排查。
- `docs/TECH_DEBT.md`：已知漂移和清理候选。
- `apps/admin-web/`：localhost-only WebAdmin；观察页用于实时活动和技术下钻，独立“管理操作”页只开放四种带预览、确认、停机检查和审计的固定维护操作，运行与安全边界见 `docs/OPERATIONS.md`。
- `plans/`：多步任务的实现计划和决策记录。

## 维护规则

- 架构变化要同步更新对应文档。
- 优先链接代码路径，不要复制大段实现细节。
- 除非是稳定契约，否则不要把生成数据或运行时数据写进文档。
- 交回工作前运行 `pnpm repo-check`。
