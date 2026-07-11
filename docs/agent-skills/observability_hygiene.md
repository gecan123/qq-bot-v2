---
name: observability_hygiene
description: 新增或修改生产外部集成、后台任务、工具审计、日志或指标设计时使用；不改变诊断能力的普通业务逻辑修改不要使用。
---

# 可观测性卫生

能运行不等于能排查。新增会在生产运行的能力时，要让 owner 以后能从日志和指标回答“发生了什么、为什么、影响多大”。

先写问题:

- 这个功能成功的信号是什么？
- 失败时 owner 会先问哪 2-4 个问题？
- 哪些字段能定位一次请求、一个任务或一次工具调用？

日志规则:

- 记录事件，不记录散文。事件名稳定，字段可查询。
- 副作用工具必须有审计日志，包含工具名、操作、关键非敏感参数、成功状态、错误 code 和耗时。
- 关联字段要稳定，例如 requestId、taskId、source key、tool call id。
- 不记录密码、token、cookie、验证码、完整 PII、完整请求体或私密图片内容。

指标规则:

- 对外依赖、后台任务和工具调用至少能看 rate、errors、duration。
- label 只能用小而固定的集合，例如 tool、operation、status_class、provider。
- 不把 userId、QQ 号、完整 URL、错误消息、requestId 放进指标 label。
- 延迟看 p95/p99 或 histogram，不只看平均值。

验证:

- 本地能跑时，用 focused test 或最小命令触发成功和失败路径。
- 不能真实运行外部服务时，说明跳过原因，并确认结构化日志/测试覆盖了关键字段。
- 日志是运维证据，不得用于 replay 重建。
