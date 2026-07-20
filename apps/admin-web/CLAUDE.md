# Admin Web Agent 指令

本目录是只读 WebAdmin，技术栈为 TanStack Start、React、TanStack Router/Query、Tailwind CSS 4 和 Zod。

- 修改前先读仓库根 `AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/AGENT_CONTEXT.md` 和对应设计/实施计划。
- 浏览器代码不得导入 Prisma、Node API、环境变量、bot runtime 或 server-only 模块。
- 数据库和文件访问只允许出现在显式 `*.server.ts` 模块；server-only 模块首行导入 `@tanstack/react-start/server-only`。
- 第一阶段所有管理接口只读。禁止直接更新 ledger、runtime state、checkpoint、Goal、消息、媒体或 workspace side-data。
- 所有跨 server/client 数据必须经过 Zod DTO；BigInt 转十进制字符串，Date 转 ISO 8601。
- 默认绑定 `127.0.0.1`。没有另行设计鉴权前，不得暴露到非可信网络。
- 新行为测试先行；至少运行本 app 的 test、typecheck、build，再运行根 `pnpm repo-check`。
