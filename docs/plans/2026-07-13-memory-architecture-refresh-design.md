# 记忆架构重整设计

## 背景

普通 `journal` 已被 topic-oriented `notebook` 替代，梦境进入 `life_journal`，旧 PostgreSQL `memory_entries` 也已退出运行时和 schema。当前代码边界已经变化，但知识地图仍缺少一份从“入站事实”一直讲到“长期状态”的完整记忆架构说明。

## 方案比较

1. 只扩写 `docs/ARCHITECTURE.md`：入口最少，但会把通用运行架构和记忆细节混在一起。
2. 新增专门的 `docs/MEMORY_ARCHITECTURE.md`，再从知识地图、总架构和 Agent 指令链接：职责最清晰，也方便修改记忆、context、replay、compaction 或 review 时集中核对。采用此方案。
3. 只更新 `docs/TOOLS.md`：能说明工具 API，但无法表达事实账本、LLM ledger、side-data 与 replay 的关系。

## 目标结构

新文档按以下顺序组织：

1. 先声明“持久化状态不都属于记忆”。
2. 用一张表区分 `messages`、`AgentContext`、working projection、`memory`、Notebook、Life Journal、Agenda、Goal 和日志。
3. 用数据流图说明入站事实如何经 mailbox/inbox 进入 ledger，以及四种长期状态如何通过显式工具结果被按需披露。
4. 给出写入路由：稳定事实写 memory；演进过程写 Notebook；经历/感受/梦写 Life Journal；当前承诺/下一步写 Agenda。
5. 说明各层的读取、维护、并发、格式、reset 与 replay 边界。
6. 记录当前优先改进项，但不在本任务中扩大为实现修改。

## 当前判断

- 当前四层长期状态分工合理，应继续保留，不重新合并。
- `messages` 和 `AgentContext` 必须与长期 side-data 分开描述；前者是事实与可 replay ledger，后者是按需披露资料。
- Memory maintenance 的 revision 冲突重排队是正确方向。
- Notebook 保持显式维护，不自动晋升到 memory。
- Life Journal reviewer 更新 Agenda 未使用 revision，且 reviewer append 与主 Agent mutation 缺少统一串行边界，是当前最高优先级一致性风险。
- `agent:reset-memory` 实际同时清理 snapshot、Goal 和四类 workspace 状态，命名比行为窄；后续应拆分 scope 或改名。

## 非目标

- 不从日志或 `messages` 自动重建长期记忆。
- 不增加跨 store 自动搬运或 dual-write。
- 不为旧 `journal` 增加兼容 adapter。
- 不在本轮修改运行时代码。
