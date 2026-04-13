# Proactive `implicit_text` 策略隔离设计（@ 必回，主动可沉默）

日期：2026-04-13  
状态：Implemented（代码已落地，待运行时 dry-run 场景观察）

## 实施状态

- 已完成：
  - `runAgentLoop` 增加 `allowImplicitText` 策略开关（默认 `true`）
  - 禁用场景下 direct text 走 `fallback: implicit_text_disallowed`
  - 新增日志事件 `agent_loop_implicit_text_disallowed`
  - `runAgentSession` 支持策略透传
  - `@` 链路显式 `allowImplicitText: true`
  - proactive 链路显式 `allowImplicitText: false`
  - 新增 loop 单测覆盖 disallow 分支并通过
- 待观察：
  - 真实 dry-run 日志中 `agent_loop_implicit_text_disallowed` 命中率与主动沉默比例

## 1. 背景与问题

当前主动发言（proactive）链路中，模型在未调用 `final_answer` 工具时，仍可能直接返回文本。`agent loop` 会将这类文本按 `termination=implicit_text` 视为有效最终答案并透传到上层。

在话题重复场景下，这会出现“这个我已经说过了，不重复”之类元话术，用户体感是“模型不愿意回复但仍强行说了一句”。

## 2. 目标

- 被 `@` 触发：尽量保证有回复（保留 `implicit_text` 兜底）。
- 主动发言（proactive）：宁可沉默，也不接受“勉强回复”的 `implicit_text`。

## 3. 非目标

- 不修改 proactive 打分/gate 公式。
- 不引入文案黑名单（例如硬编码拦截“不重复”）。
- 不强制所有场景必须工具调用。

## 4. 设计概览

把“是否允许 `implicit_text` 作为最终答案”提升为 **调用方策略**：

- `@` 链路：`allowImplicitText = true`
- proactive 链路：`allowImplicitText = false`

统一在 `runAgentLoop` 中执行策略，避免在上层做脆弱的字符串过滤。

## 5. 详细设计

### 5.1 `runAgentLoop` 增加策略参数

文件：`src/agent/loop.ts`

- 新增参数：`allowImplicitText?: boolean`，默认 `true`（兼容历史行为）。
- 分支逻辑：
  - `turnResult.type === "text"` 且 `allowImplicitText === true`：维持现状，返回 `final + implicit_text`。
  - `turnResult.type === "text"` 且 `allowImplicitText === false`：返回 `fallback`，`reason = "implicit_text_disallowed"`。
- 新增日志事件：`agent_loop_implicit_text_disallowed`（warn），便于统计主动沉默触发量。

### 5.2 `runAgentSession` 透传参数

文件：`src/responder/agent-session.ts`

- `AgentSessionParams` 增加 `allowImplicitText?: boolean`。
- 传递到 `runAgentLoop`。

### 5.3 两条业务链路显式声明策略

文件：
- `src/responder/reply-generator.ts`（@ 回复链路）
- `src/responder/proactive/generator.ts`（主动发言链路）

行为：
- @ 回复：显式 `allowImplicitText: true`
- proactive：显式 `allowImplicitText: false`

## 6. 数据流与状态变化

### 6.1 @ 链路

1. 模型返回 `tool_calls(final_answer)` -> 正常 final。
2. 模型直接文本 -> 仍可作为 `implicit_text` 返回。
3. 上层继续走发送流程（保持“被@尽量回复”）。

### 6.2 proactive 链路

1. 模型返回 `tool_calls(final_answer)` -> 正常 final。
2. 模型直接文本 -> 被 loop 拒绝（`fallback: implicit_text_disallowed`）。
3. `evaluateAndReply` 因非 final 直接返回 `false`，本轮沉默；不发送、不记 recentReplies。

## 7. 错误处理与可观测性

- 非预期异常沿用既有 `agent_loop_error`。
- 策略性拒绝单独归因到 `implicit_text_disallowed`，避免与 empty/runtime 混淆。
- 观测建议：
  - 检索 `agent_loop_implicit_text_disallowed` 计数
  - 对比 proactive `proactive_agent_result state!=final` 比例
  - 抽样验证“被@链路回复率”不下降

## 8. 测试计划

### 8.1 单元测试（`src/agent/loop.test.ts`）

新增/调整用例：

1. `allowImplicitText=true` + text -> `final/implicit_text`
2. `allowImplicitText=false` + text -> `fallback/implicit_text_disallowed`
3. final_answer tool call 在两种配置下都返回 final

### 8.2 集成回归

- proactive 路径：text-only 响应应沉默（返回 false）。
- @ 路径：text-only 响应仍可回。

## 9. 回滚策略

- 若上线后发现 proactive 过度沉默，可先临时将 proactive 调用改回 `allowImplicitText: true`。
- 保留参数默认 `true`，确保最小回滚范围。

## 10. 方案取舍

### 备选 A（未选）

在 proactive 层做字符串黑名单（拦“不重复”等句式）。

问题：脆弱、可绕过、维护成本高。

### 备选 B（未选）

全局强制 `tool_choice=final_answer`。

问题：影响 @ 链路弹性，改动面更大。

### 最终选择

采用“调用方策略开关”方案：

- 满足“@ 必回 / 主动可沉默”
- 变更点小、可观测、易回滚
