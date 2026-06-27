---
name: tool_help
description: 不确定工具语法或能力入口时使用
---

# 工具帮助入口

不确定工具语法、能力边界或下一步入口时使用本 skill。不要为了显得会用工具而加载，只有卡住时再看。

- `workspace_bash command="help"`: 查看总入口。
- `workspace_bash command="help workspace"`: 私有工作区读写。
- `workspace_bash command="help repo"`: 只读查看仓库代码。
- `workspace_bash command="help journal"`: 日记和梦境。
- `workspace_bash command="help db"`: 只读数据库查询。
- `workspace_bash command="help style"`: 聊天约束和风格细则。
- `workspace_bash command="help fetch"`: URL、图片、头像、Reddit。
- `todo action=list/update`: 管当前多步计划，同一时间最多一个 `in_progress`。

对外 QQ 发言只能用 `send_message`。异步工具返回 `taskId` 或收到后台任务完成事件后，用 `background_task action=list/get` 查状态和结果。
