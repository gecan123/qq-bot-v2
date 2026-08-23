# Domain Context Map

仓库采用两个明确上下文；共享边界通过稳定 DTO、PostgreSQL 只读查询或受控 operations service 连接。

| 范围 | 入口与事实来源 | 主要边界 |
| --- | --- | --- |
| Bot / backend | 根 `AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/AGENT_CONTEXT.md`、`docs/MEMORY_ARCHITECTURE.md`、`src/**`、`prisma/schema.prisma` | Agent Core、gateway、事实账本、canonical ledger、工具与 workspace state |
| WebAdmin | `apps/admin-web/AGENTS.md`、`apps/admin-web/src/**` | localhost-only 管理面；观察 feature 只读，固定 operations feature 是唯一写入口 |

跨上下文修改先确认契约归属。文档和实现冲突时，以 schema、代码、测试和当前运行证据为准。
