---
name: tool_contract_design
description: 新增或修改 bot tool schema、注册、result、deferred capability、workspace_bash 子命令或工具说明时使用；仅调用现有工具且不改变契约时不要使用。
---

# 工具契约设计

工具是 Agent 和外部世界的边界。契约要稳定、可审计、可 replay。

注册和暴露:

- 工具注册集中在 `src/agent/tools/index.ts`。
- 声称某个工具存在前，先查注册表。
- 默认常驻能力只放高频、低噪音入口；重能力通过稳定的 `help` / `invoke` 壳按需发现、激活和调用，激活不改变顶层 tools 列表。
- 新增能力时同步检查 `docs/TOOLS.md` 和 system prompt 的按需披露索引。

参数设计:

- schema 要表达明确 action、必填字段和边界。
- 有副作用的工具必须要求明确 target 或资源 id。
- 不要让 LLM 传裸 shell、任意路径、任意 URL 或无上限文本，除非 wrapper 已经做 allowlist、timeout、上限和审计。

结果设计:

- 只有 `ToolExecutionResult.content` 进入 `AgentContext`。
- `outcome` 和 `effects` 只服务当前运行时，不能 append、持久化或用于 replay 重建。
- 需要后续机器判断的结果使用稳定 JSON。
- 截断必须发生在字段或数组条目层，并用 `truncated` 或类似字段说明。
- 不要把 stdout 看起来像 JSON 就自动解释；保留命令信封和退出码。

测试:

- schema、参数校验、错误 code、截断和副作用拒绝路径都应有 focused tests。
- 修改工具说明可能影响 prompt cache，集中处理并说明原因。
