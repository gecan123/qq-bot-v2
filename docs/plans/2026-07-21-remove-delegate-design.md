# 移除通用 Delegate 设计

## 背景

仓库当前提供一个通用 `delegate` 工具。主 Agent 可以把一次性调查任务交给独立的临时 `AgentContext`，由后台 scheduler 运行多轮 LLM，并通过 `background_task` 取回最终结果。

该能力存在已确认的正确性缺陷：每轮 `runReactRound()` 返回的 `messagesToAppend` 没有安装回 delegate 的局部上下文，因此后续轮次看不到前一轮工具调用和结果。修复这一缺陷还会继续保留第二套多轮 LLM 控制流、独立 prompt cache/usage 归因、后台结果回流和额外错误恢复边界。

当前产品已有边界更明确的后台机制：`background_task`、`trading_agent`、Memory maintenance、Life review 和媒体任务。现阶段没有必须由通用 clean-context delegate 承担的产品流程，因此选择删除该能力，而不是修补并扩大其长期维护面。

## 决策

彻底移除通用 `delegate` 能力：

- 主 Agent 不再声明或注册 `delegate` 工具。
- 删除 delegate 的临时多轮 LLM loop、`delegate_return`、固定工具 allowlist 和专属 scheduler lane。
- 删除相关 tool policy、测试和文档声明。
- 保留通用 `BackgroundTaskRegistry`、`background_task` 工具和 scheduler 基础设施。
- 保留 `trading_agent`、Memory maintenance、Life review、媒体处理等专用后台 worker。
- 保留 `runReactRound()` 的 `stagedMessages`；主 Agent 的 Runtime Host 仍需要它。

删除后，通用 Goal 调查和群聊由主 Agent 串行处理。未来只有在出现可测量的群聊响应延迟，而且现有专用后台任务无法覆盖时，才按实际需求设计目标明确的 research worker。

## 代码范围

删除：

- `src/agent/tools/delegate.ts`
- `src/agent/tools/delegate.test.ts`

修改：

- `src/agent/tools/index.ts`：移除 import、构造和工具注册。
- `src/agent/tools/policies.ts`：移除 delegate policy。
- `src/agent/task-scheduler.ts`：移除默认 `delegate` lane。
- 依赖完整工具列表或 scheduler lane 的测试：更新期望值。
- `src/agent/agent-context.ts`：移除仅以 delegate 为例的注释；保留局部 context API。
- `src/agent/goal-render.ts`：不再引导主 Agent 使用 delegate。

不修改：

- `runReactRound()` 和 `stagedMessages`。
- `BackgroundTaskRegistry` 与 `background_task`。
- Agent ledger、runtime state、QQ focus、Goal 和 prompt cache 的数据模型。
- Prisma schema 和 migrations。

## 文档范围

同步更新：

- `docs/TOOLS.md`
- `docs/ARCHITECTURE.md`
- `docs/AGENT_CONTEXT.md`
- `docs/HARNESS_COMPARISON.md`
- `docs/TECH_DEBT.md`

`docs/TECH_DEBT.md` 删除 delegate P0；usage/cache 技术债继续保留其他辅助 LLM 调用的归因缺口，但不再提 delegate。同时修正 WebAdmin 被概括为完全只读运维面的语义漂移：观察 feature 只读，固定 operations feature 是唯一受控写入口。

## 兼容与恢复

不增加 deprecated stub、adapter 或迁移脚本。

历史 append-only ledger 如果曾保存 `delegate` assistant tool call 和对应 tool result，仍作为普通 canonical 历史 replay。删除当前工具声明不要求删除或重写旧 entry。未来模型请求不再看到该工具，因此不能创建新的 delegate task。

历史 background task 记录仍可作为完成或中断记录读取，但不提供重新执行 delegate 的兼容路径。

## 验证

1. 先更新并运行受影响的 scheduler、tool registry、runtime focused tests。
2. 运行 `pnpm typecheck`。
3. 运行 `pnpm test`。
4. 运行 `pnpm repo-check`。
5. 搜索产品级 `delegate` 引用；忽略 Prisma 生成代码中表示 ORM model delegate 的无关词义。
6. 检查最终 diff 和工作区，确保不修改 `data/agent-workspace/` 或用户已有未跟踪文件。
