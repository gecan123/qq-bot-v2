# Domain docs

本仓库采用 multi-context，领域词汇与 ADR 按范围披露，避免把 bot/backend 和 WebAdmin 的细节同时塞入 Agent 上下文。

## 路由

根 `CONTEXT-MAP.md` 负责指向：

- bot/backend：根 `CONTEXT.md`
- WebAdmin：`apps/admin-web/CONTEXT.md`

这些文件按需创建；缺失时静默继续，不为了满足目录结构提前填充空文档。

## 探索前读取

所有范围先读取：

- `AGENTS.md`
- `docs/README.md`
- `docs/ARCHITECTURE.md`
- 与任务有关的现有专题文档
- `docs/adr/` 中相关的系统级 ADR

bot/backend 任务读取根 `CONTEXT.md`。涉及 context、replay、compaction、消息渲染、system prompt、tool description 或图片 handle 时，额外读取 `docs/AGENT_CONTEXT.md`。

WebAdmin 任务读取：

- `apps/admin-web/AGENTS.md`
- `apps/admin-web/CONTEXT.md`
- `apps/admin-web/docs/adr/` 中相关 ADR

## 事实优先级

代码、schema、测试和实际日志优先于领域文档。现有架构专题文档保持事实来源；`CONTEXT.md` 只维护领域词汇、边界和必要指针，不复制完整架构说明。

## 词汇和 ADR

输出中的 issue 标题、测试名、假设和重构建议应使用对应 `CONTEXT.md` 定义的领域词汇。

如果需要的概念尚未定义，交给 `/domain-modeling` 判断是否应补充。如果方案与现有 ADR 冲突，必须显式指出，不得静默覆盖。
