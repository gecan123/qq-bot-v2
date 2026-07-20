# 运维安全加固设计

## 背景

当前三个高优先级技术债会降低运维判断和破坏性操作的安全性：测试进程会写入默认运行日志，普通 `agent:metrics` 会把 `model=mock` 混入汇总；`agent:reset-memory` 的名称不能表达它会删除完整 Agent 持久状态；观测数据库表与主要 NDJSON 日志没有统一 retention。

本次只修复这三项，不顺带调整 provider tool choice、媒体去重或 replay 告警。

## 目标

- 测试运行不再污染仓库内的 app、token 或 tool-call 日志。
- `agent:metrics` 默认反映真实模型数据，同时仍允许显式检查 mock 数据。
- 破坏性 reset 必须使用准确名称、显式 scope 和确认门。
- messages/media 继续保留 7 天；观测数据库表及主要 bot NDJSON 默认保留 30 天，并支持关闭或覆盖。
- 观测清理失败不得阻止 bot 启动；无法解析时间戳的 NDJSON 行不得静默丢失。

## 方案

### 测试日志与 metrics

`scripts/test-env.mjs` 在测试进程加载应用模块前关闭默认 app 文件日志，并把 token/tool-call 日志路径指向系统临时目录。测试仍可在终端看到日志，但不会向仓库的 `logs/` 追加运行证据。

`agent:metrics` 默认排除 `model=mock`。显式传入 `--model mock` 时视为调用者有意检查测试数据，不应用默认排除规则。纯汇总函数与 log/DB 两条 CLI 数据源保持相同语义。

### Reset scopes

删除误导性的 `agent:reset-memory` 入口，替换为：

```text
pnpm agent:reset-state -- --scope all
pnpm agent:reset-state -- --scope context
pnpm agent:reset-state -- --scope knowledge
```

package script 继续内置 `--confirm`，直接运行底层脚本时缺少确认参数仍会拒绝。scope 缺失或未知也会拒绝，不提供隐式默认值。

- `all`：执行 context 与 knowledge 两组清理。
- `context`：在数据库事务中删除 ledger、checkpoint、runtime 和 Goal，随后创建空 runtime singleton；保留长期 Markdown 状态。
- `knowledge`：删除 Memory、遗留 Journal、Notebook 和 Life 目录；不连接或修改数据库。

不提供独立 Goal scope。Goal revision、ledger 可见事件和 runtime control state 需要保持一致，单独物理删除 Goal 会留下含混的 replay 状态。

### 统一 retention

messages/media 继续使用现有 7 天启动清理。新增统一观测 retention，默认 30 天，通过一个环境变量配置；值为 `0` 时关闭观测清理，非法值启动期拒绝。

观测数据库清理覆盖 `agent_tool_calls.ts` 与 `agent_token_usage.ts` 早于 cutoff 的行。NDJSON 清理覆盖主 bot 管理的 token usage、tool-call 与 fetch 日志；app log 继续由现有 pino 大小轮转负责，browser sidecar 日志不在本次范围。

NDJSON 使用同目录临时文件写入后原子替换。有效且早于 cutoff 的记录被删除；时间戳缺失、格式错误或整行无法解析时保留原文并计入 warning，避免静默删除审计证据。重复配置到同一路径的日志只处理一次。

messages/media 清理保持当前失败语义。观测数据库或 NDJSON 清理是 best-effort：单一目标失败只记录结构化 warning，其余目标继续，bot 启动不受阻断。

## 验证

实现遵循测试先行：

- metrics 单元测试覆盖默认排除 mock 与显式 `model=mock`。
- 测试环境测试覆盖日志路径不再落入仓库 `logs/`。
- reset 单元测试覆盖三个 scope、缺失/非法 scope、知识范围不连接数据库和幂等性。
- retention 单元测试覆盖两个观测表、30 天 cutoff、关闭配置、NDJSON 原子裁剪、损坏行保留和单目标失败隔离。
- 更新 package scripts、`.env.example`、运维文档和技术债状态。
- 最终运行 focused tests、`pnpm test`、`pnpm typecheck` 与 `pnpm repo-check`。
