# Memory Architecture

## 结论

当前长期状态只保留两个知识容器：

- `memory`：Luna 对同一个自己、人物、群和主题形成的稳定语义记忆。
- `notebook`：研究、阅读、市场和项目等仍在演进的跨天过程。

定时重新唤醒由 Schedule 表示。Life Journal 和 Agenda 已退出系统。它们的职责不再由另一套长期日志承接：值得长期保留的结论写 Memory，跨天过程写 Notebook，未来时点写 Schedule；当前连续行动由主循环和 tool result 直接承接。

这是一个单人格、单用户系统。现在只有一层语义 Memory；未来需要更多层时，应在 Memory 模块内部增加整理、索引或更稳定的表示，而不是提前把 `layer`、文件、revision 和生命周期暴露给主 Agent。

## 三条不可破坏的边界

1. `bot_agent_ledger_entries` 是唯一持久 LLM history source，`AgentContext` 是它的当前 projection。
2. `messages` 是入站事实账本和 Memory 证据来源，不是 LLM history。
3. Memory、Notebook、Schedule 和日志都是 side state，不能用于重建 transcript。

只有显式工具读取的结果被 append 到 canonical ledger 后，side state 才进入可 replay 的 LLM 上下文。启动、compaction 或恢复都不得隐式扫描这些文件注入 prompt。

## 状态分工

| 问题 | 存储 | 写入口 | 读入口 | 是否参与 replay |
| --- | --- | --- | --- | --- |
| 我长期知道什么？ | `data/agent-workspace/memory/` | `memory remember/correct` | `memory recall` | 仅显式工具结果 |
| 这个主题进行到哪里？ | `data/agent-workspace/notebook/` | `notebook checkpoint` | `notebook list/search/read` | 仅显式工具结果 |
| 未来什么时候重新评估？ | Schedule runtime | `schedule` | scheduled wake | wake 事件进入 canonical context |

简单判断：

- 已稳定、未来可能再次有用的事实、偏好、规则或经验：Memory。
- 仍会增长、需要保留材料和阶段变化：Notebook。
- 当前连续行动：由 canonical context、tool result 和进程内 `work=continue` 承接，不另建持久任务状态。
- 到某个时间再重新评估：Schedule。
- 只对当前对话有用：不持久化。

## Memory 的外部 Interface

主 Agent 只看到三个动作：

- `remember`：按 `self/person/group/topic` 写一条语义记忆。
- `recall`：按问题和可选范围召回相关记忆。
- `correct`：用 recall 返回的不透明 `ref` 替代错误事实。

外部接口不暴露文件路径、entry ID、revision、recent/stable、status、memoryKind 或 maintenance 动作。`ref` 只用于把一次 recall 命中安全地交回 correct；过期 ref 会明确失败，Agent 重新 recall 即可。

Memory 内部仍可保留 append-only replacement、revision/CAS、来源证据、maintenance 和相关性排序。这些是模块实现，不是调用者必须理解的概念。

Memory 与 Notebook 的 Markdown 是各自 side state 的事实来源；派生索引只能从 Markdown 重建，不能反过来覆盖它。任何交给 maintenance reviewer 或其他辅助 LLM 的历史条目都必须包在“不可信数据（UNTRUSTED_DATA）”边界内，正文中的指令不能取得控制权。

### 范围与证据

- `self`：Luna 自己的稳定偏好、方法和经验。
- `person`：同一个人的稳定资料；必须带稳定参与者 ID 和当前 conversation context。
- `group`：某个会话群的稳定规则、节奏和共同背景；ID 使用 conversation key。
- `topic`：不绑定人物或群的长期主题知识。
- person/group 的 `remember` 和 `correct` 必须引用真实 `messages.rowId`。
- evidence kind 由工具根据消息来源推导，主 Agent 不再手工选择。
- 人物或群记忆的证据必须来自匹配的 conversation context，避免跨场景串写。

Memory 写入前应先 recall，减少重复。事实发生变化时用 correct，不删除旧条目；旧条目在内部标记 superseded，从而保留可追溯关系。

## Notebook

Notebook 的路径为 `notebook/<kind>/YYYY-MM.md`，`kind` 当前为 `research/reading/market/project/general`。主 Agent 只提交一个稳定 topic 的完整当前状态：首次 checkpoint 创建记录，后续 checkpoint 保留稳定 ID、更新 `updatedAt` 并替换正文；同 kind、同 topic 的旧重复记录会在下一次 checkpoint 时跨月份收敛。list/search 只披露每个 topic 的最新状态，月文件 revision、去重和原子写入都留在 Notebook 模块内部。

Notebook 保存过程，不承担“另一个 Memory 层”的角色。结论稳定后，用自己的话写入 Memory；不要自动复制整段 Notebook。未来若出现真实需求，可让 Memory 内部引用 Notebook source ref，但不应把跨容器晋升做成常驻 prompt 规则。

## 写入与并发

- Memory 和 Notebook 修改都经过稳定路径、结构化格式和 revision/CAS 校验。
- 单进程内 writer 通过共享 `WorkspaceStateCoordinator` 按资源键串行化；不同资源可以并发。
- coordinator 不是跨进程锁，运维上仍只允许一个真实 Bot writer。
- 人类可读的长期状态正文以中文叙述；命令、路径、URL、API、模型名和专有名词可保留原文。
- 不从可变 side state 隐式构造 system prompt，也不做跨 store dual-write。

## 检查与重置

`pnpm agent:memory-check` 只读检查 Memory 和 Notebook：

- 文件格式和条目计数；
- 重复 ID；
- Memory supersedes 引用；
- lifecycle 异常统计。

重置范围：

- `context`：清空 canonical ledger/checkpoint/runtime，不删除 Memory 或 Notebook。
- `knowledge`：只删除 `memory/` 与 `notebook/`，不连接数据库。
- `all`：清空 context，并删除 workspace 中除 `.gitignore` 和 `README.md` 外的生成内容。

重置不会启动 Bot。WebAdmin 仍要求预览、确认、Bot 停止检查、single-flight runner 和本地审计。

## 未来如何扩展

只有出现真实召回质量或容量问题时才扩展 Memory 内部：

1. 先增加内部索引或摘要，不改 `remember/recall/correct`。
2. 再考虑把高频、稳定、抽象程度更高的表示作为内部层级。
3. 仍由 recall 统一选择结果，外部不传 `layer`。
4. 若接口确实无法表达新需求，再用新证据修改 Interface。

这样现在是一层，未来可以在同一层下面继续细化，而不需要迁移主 Agent 的调用方式。

## 代码入口

- `src/agent/tools/memory.ts`：主 Agent 的三动作 Interface 与 opaque ref。
- `src/agent/memory-store.ts`：Memory 文件格式、召回、修正和内部生命周期。
- `src/agent/memory-evidence.ts`：消息证据和 conversation context 校验。
- `src/agent/memory-maintenance.ts`：内部维护。
- `src/agent/tools/notebook.ts`、`src/agent/notebook-store.ts`：Notebook。
- `src/ops/agent-memory-check.ts`：只读结构检查。
- `src/ops/reset-agent-state.ts`：context/knowledge/all 重置边界。
- `docs/AGENT_CONTEXT.md`：canonical ledger、projection 和 compaction 不变量。
