# 统一状态抽取设计

**日期：** 2026-07-17  
**状态：** 已确认  
**范围：** 复用现有 Life Journal 异步 review，在同一次辅助模型调用中提取 recent Memory 候选

## 背景

当前长期 Memory 只有主 Agent 显式调用 `memory action=write` 才会产生第一条 recent entry。Memory maintenance 只整理已经存在的 entry，不从聊天中抽取新事实。现有 Life Journal runtime 已在成功轮次后异步审阅本轮 delta，并按十分钟节流决定是否写 Journal 或更新 Agenda。

实验阶段不增加第二个辅助模型调用。现有 Life review 同时承担三类彼此独立的路由判断：稳定事实进入 Memory，主观经历进入 Journal，当前承诺和下一步进入 Agenda。

## 方案选择

采用最小扩展方案：保留 `LifeJournalRuntime` 和当前调度语义，只扩展结构化 review 结果与写入依赖。

未采用：

- 新建独立 Memory extractor：边界清楚，但每个 review 周期多一次模型调用。
- 立即重构为 `StateExtractionRuntime`：命名更准确，但实验功能不值得扩大重构面。

## 数据流

1. BotLoop 成功完成一轮后，继续把有界 round delta 提交给现有 Life runtime。
2. pause-only round 继续跳过；其他 round 继续使用十分钟节流，不为“记住”类措辞绕过节流。
3. reviewer 一次返回：
   - `memoryCandidates`：0–3 条可长期复用的稳定事实、偏好、方法或结论；
   - `journalMarkdown`：可选主观经历记录；
   - `agendaMarkdown`：可选完整 Agenda 更新。
4. 每条 Memory candidate 只通过现有 Memory store 写成 `recent`，不允许 reviewer 直接生成 `stable`。
5. 新建 recent entry 后，继续交给现有 Memory maintenance 做去重、晋升、合并或争议处理。
6. Journal、Agenda 和 Memory 仍写入各自独立 Markdown 真源；reviewer 只共享一次分类调用，不合并存储。

## Memory 候选边界

- 每次最多三条。
- `scope` 只允许 `self|person|group|topic`。
- person/group 必须提供明确目标 ID；topic 必须提供稳定 title。
- 有可用的入站 Message row ID 时保留为 `sourceMessageIds`。
- 内容用 Luna 自己的话压缩表达，不复制长聊天原文。
- 普通寒暄、一次性饮食天气、未证实传闻、临时安排和研究过程不写长期 Memory。
- store 自身的内容去重、路径约束、revision/CAS 和 writer 串行化继续生效。

## 失败边界与观测

- reviewer 协议无效、超时或整体失败时维持现有安全跳过语义。
- 单条 Memory candidate 非法或写入失败时记录日志并继续处理其他候选以及 Journal/Agenda，不能影响主聊天。
- 记录本轮候选数、Memory 新建数、去重数和失败数；token usage 继续计入现有 `life_journal.review` operation，便于直接比较改动前后成本。
- reviewer 继续关闭 thinking，输入继续使用 `[UNTRUSTED_DATA]` 信封，默认十分钟节流和一次协议重试保持不变。

## 测试范围

这是实验功能，只保留少量核心回归：

- 同一次 review 能写 recent Memory，并仍可写 Journal/Agenda。
- 普通 skip 不产生 Memory。
- 新建 Memory 会触发 maintenance；完全相同内容不会重复触发。
- 十分钟节流和 pause-only skip 不变。
- focused tests、typecheck 和 repo-check 通过。

不建设真实模型行为语料库，不测试开放式抽取质量，也不修改生产 recall、ledger、compaction 或 system prompt。
