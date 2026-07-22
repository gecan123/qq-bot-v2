# Issue tracker：GitHub

本仓库的 issues、PRD 和跨会话 tickets 存放在 `gecan123/qq-bot-v2` 的 GitHub Issues，使用 `gh` CLI 操作。

只有用户显式调用会发布工作的 skill（如 `to-spec`、`to-tickets`、`triage`、`wayfinder`）时才执行 GitHub 写操作。

## 常用操作

- 创建：`gh issue create --title "..." --body "..."`
- 阅读：`gh issue view <number> --comments`
- 列表：`gh issue list --state open --json number,title,body,labels,comments`
- 评论：`gh issue comment <number> --body "..."`
- 标签：`gh issue edit <number> --add-label "..."` 或 `--remove-label "..."`
- 关闭：`gh issue close <number> --comment "..."`

在仓库 clone 内运行时，由 `gh` 根据 git remote 确定仓库。

## Pull requests as a triage surface

PRs as a request surface: no.

外部 PR 默认不进入 `/triage` 队列。以后需要时可以把该值改为 `yes`。

## Skill 语义

- “publish to the issue tracker”：创建 GitHub Issue。
- “fetch the relevant ticket”：运行 `gh issue view <number> --comments`。
- bare `#42` 可能是 issue 或 PR；先尝试 `gh pr view 42`，再回退到 `gh issue view 42`。

## Wayfinder

`/wayfinder` 使用一个 map issue 和若干 child issues：

- map 添加 `wayfinder:map`
- child 添加 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task`
- 优先使用 GitHub sub-issues 和 native issue dependencies
- 不支持时，在正文中使用 `Part of #<map>` 与 `Blocked by: #<n>`
- claim ticket 时使用 `gh issue edit <n> --add-assignee @me`
- blocker 全部关闭后，ticket 才可执行
