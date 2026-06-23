# Workspace Journal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Store Luna's journal and dream entries in `data/agent-workspace/journal/` files while keeping `write_journal` as the bounded progressive-disclosure tool interface.

**Architecture:** Keep `workspace_bash` as the low-level allowlisted file tool. Move `write_journal` storage behind a small workspace-backed repository that appends JSONL entries and exposes write/list/search/read actions with bounded output. Do not reconstruct prompt history from workspace files.

**Tech Stack:** TypeScript ESM, Zod, Node `fs/promises`, Node test runner, temp directories for tests, existing `Tool` interface.

---

## Ground Rules

- Use TDD for behavior changes.
- Do not write under real `data/agent-workspace/` in tests; use temp directories.
- Do not remove `write_journal` from tool registration.
- Keep compatibility for old `{ kind, content }` write args.
- Do not change `AgentContext`, replay, compaction, or system prompt bytes.
- Do not expose raw shell as the journal API.

## Task 1: Workspace Journal Store

**Files:**
- Create: `src/agent/journal-store.ts`
- Test: create `src/agent/journal-store.test.ts`

**Step 1: Write failing tests**

Create tests for:

- `appendJournalEntry` creates the journal directory and appends a JSONL row.
- appended row includes stable fields: `id`, `kind`, `content`, `createdAt`.
- `listJournalEntries` returns newest entries first and can filter by `kind`.
- `searchJournalEntries` matches content case-insensitively.
- corrupt JSONL lines are skipped and reported through `skippedCorrupt`.

Use `mkdtemp` under `tmpdir()` and delete the temp directory in `afterEach`.

**Step 2: Run failing tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/journal-store.test.ts
```

Expected: FAIL because the store does not exist.

**Step 3: Implement minimal store**

Implement:

```ts
export type JournalKind = 'diary' | 'dream'

export interface JournalEntryRecord {
  id: string
  kind: JournalKind
  content: string
  createdAt: string
}

export interface JournalStoreOptions {
  rootDir: string
  now?: () => Date
  id?: () => string
}
```

Store records in:

```text
<rootDir>/journal/entries.jsonl
```

Use one JSON object per line. Generate ids with a timestamp plus random suffix unless tests inject `id`.

**Step 4: Run tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/journal-store.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/journal-store.ts src/agent/journal-store.test.ts
git commit -m "feat: 添加工作区日记存储"
```

## Task 2: Wire write_journal To Workspace Store

**Files:**
- Modify: `src/agent/tools/write-journal.ts`
- Modify: `src/agent/tools/write-journal.test.ts`

**Step 1: Write failing tool tests**

Update `write-journal.test.ts` to use a temp journal root and assert:

- old `{ kind, content }` writes through the workspace store.
- `{ action:"write" }` returns the new string `id`.
- `{ action:"list" }` reads from workspace files and returns previews.
- `{ action:"search" }` reads from workspace files and returns previews.
- `{ action:"read", id }` returns full content for one entry.
- unknown read id returns `{ ok:false }`.
- previews are truncated to 200 chars.

**Step 2: Run failing tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/tools/write-journal.test.ts
```

Expected: FAIL because the tool still uses Prisma `journalEntry`.

**Step 3: Implement dependency injection**

Add deps or factory shape without changing the registered export:

```ts
export interface WriteJournalDeps {
  journalRootDir?: string
  now?: () => Date
  id?: () => string
}

export function createWriteJournalTool(deps: WriteJournalDeps = {}): Tool<Args>
export const writeJournalTool = createWriteJournalTool()
```

Default root should be `data/agent-workspace`.

**Step 4: Implement read action**

Extend schema with:

```ts
{ action: z.literal('read'), id: z.string().min(1) }
```

Return one full entry as bounded JSON.

**Step 5: Remove Prisma journalEntry dependency from tool**

Delete `prisma.journalEntry` usage in `write-journal.ts`. Keep Prisma schema unchanged for now; do not add migration work unless separately requested.

**Step 6: Run tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/journal-store.test.ts src/agent/tools/write-journal.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/agent/journal-store.ts src/agent/journal-store.test.ts src/agent/tools/write-journal.ts src/agent/tools/write-journal.test.ts
git commit -m "feat: 使用工作区存储日记"
```

## Task 3: Docs And Tool Registry Check

**Files:**
- Modify: `docs/TOOLS.md`
- Review: `src/agent/tools/index.ts`
- Review: `prompts/bot-system.md`

**Step 1: Update docs**

Update `docs/TOOLS.md` to state:

- `write_journal` stores entries in the private workspace.
- `write_journal` supports `write/list/search/read`.
- Journal files under `data/agent-workspace/` are bot-generated data and should not be committed.

**Step 2: Check prompt**

Review `prompts/bot-system.md`. If it only says tool details live in tool descriptions, do not change it.

**Step 3: Run focused tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/journal-store.test.ts src/agent/tools/write-journal.test.ts
```

Expected: PASS.

**Step 4: Run broad verification**

Run:

```bash
pnpm typecheck
pnpm repo-check
```

Expected: both PASS.

**Step 5: Commit**

```bash
git add docs/TOOLS.md
git commit -m "docs: 更新工作区日记说明"
```

## Task 4: Manual Smoke Notes

**Files:**
- No required code changes.

**Scenarios for a running bot:**

- Write a diary entry.
- Write a dream entry.
- List recent dreams.
- Search for a keyword.
- Read one returned entry by id.
- Confirm no journal files were added to git status.

Do not run live QQ sends unless explicitly authorized.
