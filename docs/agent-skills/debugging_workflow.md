---
name: debugging_workflow
description: 测试失败、bot 行为异常、工具报错、日志异常或需要定位回归时使用；没有故障证据的纯新增需求不要使用，改用 repo_change_workflow。
---

# 调试工作流

调试目标是找到最小事实链，不是快速猜一个修复。

流程:

1. 复现: 明确触发条件、命令、输入、期望和实际结果。
2. 定位: 找到最小相关模块、测试或日志片段；不要一次读无关目录。
3. 缩小: 用 focused test、最小命令或最小事件样本确认问题边界。
4. 修复: 做最小改动，保留现有架构边界。
5. 防回归: 增加或更新能失败再通过的测试，或补一个 repository check。

bot/backend 事实源:

- 工具是否存在: `src/agent/tools/index.ts`。
- context/replay/compaction: 先读 `docs/AGENT_CONTEXT.md`，再读相关源码。
- 启动和运行顺序: `src/index.ts`。
- 数据契约: `prisma/schema.prisma`。
- 命令和验证: `package.json` 与 `docs/OPERATIONS.md`。

日志使用:

- 日志是运维证据，不是 prompt replay 来源。
- 读取具体错误附近的短窗口，避免把整份日志塞进上下文。
- 涉及副作用工具时看 tool-call audit，确认参数、结果和错误 code。

停下来问的情况:

- 修复需要真实连接 QQ/NapCat、外部服务、浏览器 sidecar 或数据库迁移。
- 需求在代码和文档之间冲突，且没有测试或 schema 能裁决。
- 可能改变对外发言、权限、安全边界或 replay 不变量。
