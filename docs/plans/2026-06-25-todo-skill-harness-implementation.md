# Todo and Skill Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the Claude Code harness comparison table and add minimal runtime support for s05 TodoWrite and s07 Skill Loading.

**Architecture:** Keep `BotLoopAgent`, `AgentContext`, replay, and compaction unchanged. Add two small registered tools: an in-memory `todo` tool for current-process planning and a bounded file-backed `skill` tool for loading curated docs from `docs/agent-skills/`.

**Tech Stack:** TypeScript ESM, `node:test`, Zod tool schemas, Markdown docs under `docs/`.

---

### Task 1: Persist Harness Comparison

**Files:**
- Create: `docs/HARNESS_COMPARISON.md`
- Modify: `docs/README.md`

- [ ] Add the latest `s01`-`s20` comparison table.
- [ ] Link it from the docs knowledge map.
- [ ] Run `pnpm repo-check`.

### Task 2: Add Todo Tool

**Files:**
- Create: `src/agent/tools/todo.ts`
- Create: `src/agent/tools/todo.test.ts`
- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/tools/merged-tools.test.ts`
- Modify: `docs/TOOLS.md`
- Modify: `prompts/bot-system.md`
- Modify: `src/ops/repo-check.ts`

- [ ] Write failing tests for update/list and the single-`in_progress` invariant.
- [ ] Implement the minimal in-memory tool.
- [ ] Register it in `buildBotTools()`.
- [ ] Update docs and prompt routing text.
- [ ] Run focused tool tests.

### Task 3: Add Skill Tool

**Files:**
- Create: `src/agent/tools/skill.ts`
- Create: `src/agent/tools/skill.test.ts`
- Create: `docs/agent-skills/repo_map.md`
- Create: `docs/agent-skills/tool_help.md`
- Create: `docs/agent-skills/todo_workflow.md`
- Create: `docs/agent-skills/self_review_repo.md`
- Create: `docs/agent-skills/memory_hygiene.md`
- Create: `docs/agent-skills/browser_workflow.md`
- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/tools/merged-tools.test.ts`
- Modify: `docs/TOOLS.md`
- Modify: `prompts/bot-system.md`
- Modify: `src/ops/repo-check.ts`

- [ ] Write failing tests for catalog listing and bounded loading.
- [ ] Implement frontmatter parsing and path-safe loading by skill name.
- [ ] Register it in `buildBotTools()`.
- [ ] Add the curated runtime skill docs.
- [ ] Run focused tool tests.

### Verification

- [ ] `git diff --check`
- [ ] `pnpm exec tsx --test --import tsx src/agent/tools/todo.test.ts src/agent/tools/skill.test.ts src/agent/tools/merged-tools.test.ts`
- [ ] `pnpm typecheck`
- [ ] `pnpm repo-check`
