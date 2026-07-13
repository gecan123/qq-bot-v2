# 删除遗留 Memory 表设计

## 目标

删除已不再参与运行时读写的 PostgreSQL `memory_entries` 表及其 Prisma、reset 脚本引用。当前 Markdown memory 继续以 `data/agent-workspace/memory/` 为唯一长期记忆存储。

## 边界

- 不迁移 `memory_entries` 中的历史数据；该表已被明确标记为 legacy。
- 不修改 Markdown memory 的格式、工具契约或维护流程。
- 保留历史 migration，不改写已经执行过的迁移。
- 新增一个向前 migration，使用 `DROP TABLE IF EXISTS "memory_entries"`。

## 验证

- reset-memory 测试不再提供或返回 legacy DB memory 字段。
- Prisma schema 和生成 client 不再包含 `MemoryEntry` model。
- focused tests、typecheck、repo-check 通过。
