# Agent 可读性第一阶段实现计划

> **给 Claude：** 必须使用 `superpowers:executing-plans`，按任务逐步执行本计划。

**目标：** 让仓库地图准确，并且能被机械检查。

**架构：** 保留 `AGENTS.md` 和 `CLAUDE.md` 作为持久入口指令；把更细的知识放进 `docs/`；增加轻量 `repo-check`，在 agent 交回工作前捕捉高价值漂移。

**技术栈：** TypeScript、Node test runner、pnpm scripts、Markdown docs。

---

## 任务

1. 新增 `src/ops/repo-check.test.ts`，覆盖 agent 指令镜像、README 过期引用和 package script 接线。
2. 新增 `src/ops/repo-check.ts` 和 `scripts/repo-check.ts`。
3. 接入 `pnpm repo-check`，并让 `pnpm lint` 包含它。
4. 创建 `docs/` 入口，覆盖架构、永续上下文、工具、运维和技术债。
5. 用当前 single-context 项目地图替换过期 README。
6. 用 focused repo-check test、`pnpm repo-check` 和 typecheck 验证。
