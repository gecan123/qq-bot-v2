# Journal and Notebook Consolidation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the overlapping ordinary Journal with a topic-oriented Notebook and move dream semantics into Life Journal while keeping Agenda separate.

**Architecture:** Notebook remains an explicit append/read/mutate Markdown tool for evolving topic work. Life Journal remains the selective daily episodic log and owns dream entries; Agenda remains mutable current state under the same tool.

**Tech Stack:** TypeScript, Zod, Node test runner, Markdown file stores, pnpm.

---

### Task 1: Define Notebook behavior with tests

**Files:**
- Create: `src/agent/notebook-store.test.ts`
- Create: `src/agent/tools/notebook.test.ts`

1. Add tests for stable topic writes under `notebook/<kind>/YYYY-MM.md`.
2. Add tests for kind/topic list and search filters.
3. Add tests for read/update/delete/compact with revision protection.
4. Run the two tests and confirm they fail because Notebook does not exist.

### Task 2: Implement Notebook and remove ordinary Journal

**Files:**
- Create: `src/agent/notebook-store.ts`
- Create: `src/agent/tools/notebook.ts`
- Delete: `src/agent/journal-store.ts`
- Delete: `src/agent/journal-store.test.ts`
- Delete: `src/agent/tools/journal.ts`
- Delete: `src/agent/tools/journal.test.ts`

1. Implement monthly kind files with entry metadata containing id, kind, topic and createdAt.
2. Implement bounded list/search/read and revision-protected mutations.
3. Run Notebook tests and confirm PASS.

### Task 3: Add dream kind to Life Journal

**Files:**
- Modify: `src/agent/life-journal-store.ts`
- Modify: `src/agent/life-journal-store.test.ts`
- Modify: `src/agent/tools/life-journal.ts`
- Modify: `src/agent/tools/life-journal.test.ts`

1. Add failing tests for explicit `kind=dream` writes and round-review `kind=reflection` writes.
2. Persist and parse `kind` independently from `source`.
3. Preserve kind through update; compact to dream only when all selected entries are dreams.
4. Run Life Journal focused tests and confirm PASS.

### Task 4: Rewire tools, policy and documentation

**Files:**
- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/tool.ts`
- Modify: `src/agent/tool.test.ts`
- Modify: `src/agent/tool-concurrency.ts`
- Modify: `src/agent/tool-concurrency.test.ts`
- Modify: `src/ops/reset-agent-memory.ts`
- Modify: `src/ops/reset-agent-memory.test.ts`
- Modify: `prompts/bot-system.md`
- Modify: `docs/TOOLS.md`
- Modify: repo-check fixtures as required

1. Replace the top-level `journal` tool with `notebook`.
2. Classify Notebook reads/mutations correctly and update parallel-read allowlists.
3. Clarify boundaries among Notebook, Life Journal/Agenda and memory in prompt/docs.
4. Remove live ordinary-Journal references and add `notebook` reset coverage.

### Task 5: Verify

1. Run all Notebook/Life Journal/tool focused tests.
2. Run `pnpm test`.
3. Run `pnpm typecheck`.
4. Run `pnpm repo-check`.
5. Run `git diff --check` and inspect the final diff.
