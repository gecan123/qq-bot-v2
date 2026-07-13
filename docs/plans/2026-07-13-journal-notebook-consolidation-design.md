# Journal、Notebook 与 Life 整合设计

## 决策

采用“职责重分层”，不保留两套含义接近的日记：

- `life_journal` 保存经历、感受、梦和自动回顾；按日组织。
- `life/agenda.md` 保存当前承诺、等待项和下一步；它是可变当前状态，不并入历史日志。
- `notebook` 替代普通 `journal`，按稳定 topic 记录研究、阅读、市场观察和项目过程。
- `memory` 只保存已经足够稳定、以后可直接复用的事实、偏好和结论。

## 方案比较

1. 保留全部现状：改动最小，但主 Agent 持续面对 `journal` 与 `life_journal` 的选择歧义。
2. 全部合入 Life Journal：工具最少，但研究证据、阅读进度和主观生活记录混在按日文件里，跨天主题检索较差。
3. Journal 改为 Notebook，Life Journal + Agenda 保持一体两面：工具数量不增加，四类信息边界清楚。采用此方案。

## 目标数据模型

### Life Journal

路径保持 `data/agent-workspace/life/journal/YYYY-MM-DD.md`。entry 增加：

- `kind=reflection|dream`：内容语义。
- `source=manual|round|compact`：产生方式。

自动 round review 只写 `reflection`；显式工具写入可以选择 `dream`。Agenda 继续位于 `life/agenda.md`，与 journal 共用 `life_journal` 工具和 revision 保护。

### Notebook

路径改为 `data/agent-workspace/notebook/<kind>/YYYY-MM.md`，其中 `kind` 为：

- `research`：技术、公司、产业或一般研究。
- `reading`：小说、文章和长篇阅读进度。
- `market`：行情观察、交易假设和模拟交易复盘。
- `project`：项目过程、实验和实现记录。
- `general`：确实无法归类的主题过程笔记。

每条 entry 必须有稳定 `topic`、正文、时间和 ID。list/search 支持 kind/topic 过滤；update/delete/compact 使用文件 revision 防并发覆盖。Notebook 记录演进过程，不被当作稳定事实。

## 数据流和边界

1. 一轮活动发生后，Life Journal reviewer 选择性写主观经历，并维护 Agenda。
2. 形成研究证据、阅读进度或项目阶段结果时，主 Agent 显式写 Notebook。
3. Notebook 中的结论经过多次验证后，主 Agent才写入 `memory`；不自动 promotion，避免把临时判断固化。
4. Agenda 可以引用 Notebook topic，但不复制大段正文。
5. Life Journal 可以记录“我推进了什么”，但不复制完整研究材料。

## 迁移策略

项目采用干净目标模型，不保留旧 `journal` tool/store adapter。旧 `data/agent-workspace/journal/` 不参与新运行时；reset-memory 仍会删除该遗留目录，同时新增清理 `notebook/`。当前仓库 workspace 没有需要迁移的实际 journal 文件。

## 验证

- Notebook store/tool 覆盖写入、过滤、搜索、读取、revision mutation 和 compact。
- Life Journal 覆盖 dream 写入、读取和 compact kind 规则。
- tool registry、system prompt、docs 和 tool side-effect 分类不再出现普通 `journal`。
- 全量测试、typecheck、repo-check 和 diff check 通过。
