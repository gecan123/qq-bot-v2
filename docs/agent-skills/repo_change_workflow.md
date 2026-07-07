---
name: repo_change_workflow
description: owner 明确要求修改 qq-bot-v2 仓库代码、文档、schema、工具或测试时使用
---

# 仓库修改工作流

这个 skill 面向被授权的仓库修改。普通自审仍用 `self_review_repo`，不要擅自改源码。

开始前:

- 先读 `docs/README.md` 找入口。
- bot/backend 任务优先读 `docs/ARCHITECTURE.md`、`docs/AGENT_CONTEXT.md`、`docs/TOOLS.md`、`docs/OPERATIONS.md`。
- 判断工具是否存在时查 `src/agent/tools/index.ts`。
- 当前主要范围是 bot/backend；不要假设 admin WebUI 存在。

实现原则:

- 项目是 ESM-only，本地 TypeScript import 使用 `.js` 扩展名。
- Prisma client 输出目录是 `src/generated/prisma/`。
- 优先选择干净目标模型，不围绕旧 bridge 或 adapter 设计。
- 不要提交 `data/agent-workspace/` 下的 bot 生成物。
- 不要启动会连接 QQ/NapCat、浏览器 sidecar、数据库或长期驻留的真实进程，除非任务明确需要。

验证:

- 改代码先跑最小有用测试。
- 影响 context、replay、compaction、tool schema 或发送路径时，跑相关 focused tests，再考虑 `pnpm typecheck`。
- 只改文档时，检查 diff 并运行 `pnpm repo-check`。
- 修改 `prisma/schema.prisma` 后运行 `pnpm db:generate`。

交付:

- 说明改了哪些文件、跑了什么验证。
- 如果跳过验证，明确原因。
- 提交信息格式是 `<type>: <中文描述>`，允许 type: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`。
