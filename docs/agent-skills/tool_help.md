---
name: tool_help
description: 不确定工具语法、deferred capability、参数 schema 或正确能力入口时使用；已经知道现有工具和参数的直接调用不要使用。
---

# 工具帮助入口

不确定工具语法、能力边界或下一步入口时使用本 skill。不要为了显得会用工具而加载，只有卡住时再看。

- `workspace_bash`: 只读执行 `pwd/ls/rg/cat/head/tail/wc`，workspace 和 repo 都不经过 shell。
- `help action=list`: 查看按需 capability。
- `help action=describe tool=<name>`: 查看内部工具说明和参数 schema。
- `invoke tool=<name> args=<object>`: 直接调用按需工具；目标 schema、policy 和 approval 仍然生效。
- 数据库用 `db`，指标用 `metrics`，聊天风格用 `chat_style`，外部抓取用 `fetch_content`；不要从 `workspace_bash` 绕行。

对外 QQ 发言只能用 `send_message`。异步工具返回 `taskId` 或收到后台任务完成事件后，用 `background_task action=list/get` 查状态和结果。
