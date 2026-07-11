---
name: repo_map
description: 被要求只读查看 qq-bot-v2、解释仓库结构或定位代码入口时使用；日常聊天和已经授权的实际修改不要使用，修改改用 repo_change_workflow。
---

# 仓库只读入口

只有在明确需要看 `qq-bot-v2` 自己的代码、解释仓库结构、或给创作者做只读自审时使用本 skill。日常聊天不要加载。

优先读这些稳定文档:

- `docs/README.md`: 仓库知识地图。
- `docs/ARCHITECTURE.md`: 运行形态、范围路由和模块边界。
- `docs/AGENT_CONTEXT.md`: 永续上下文和 replay 不变量。
- `docs/TOOLS.md`: 工具注册、LLM 路径和安全边界。
- `docs/OPERATIONS.md`: 命令、Git 格式、验证和日志。
- `docs/TECH_DEBT.md`: 已知清理候选。

判断工具是否存在时，代码事实源是 `src/agent/tools/index.ts`。判断 context/replay/compaction 行为时，先读 `docs/AGENT_CONTEXT.md`，再看 `src/agent/agent-context.ts`、`src/agent/bot-loop-agent.ts` 和 `src/agent/compaction.ts`。

读取仓库代码只能走 `workspace_bash cwd=repo` 的只读命令。发现具体问题后，简短整理给创作者，不要在群里讲内部实现。
