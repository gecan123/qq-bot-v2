# Unified State Extraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the existing ten-minute Life Journal review so the same auxiliary LLM call can write up to three recent Memory entries without changing recall or ledger behavior.

**Architecture:** Add bounded `memoryCandidates` to the existing structured review result, persist each candidate through `writeMemoryEntry`, and enqueue newly created entries into the existing Memory maintenance runtime. Keep `LifeJournalRuntime`, its throttle, async scheduler, token operation, Journal/Agenda stores, and plain-text fallback behavior intact.

**Tech Stack:** TypeScript ESM, Zod, Node test runner, Markdown Memory store, existing maintenance scheduler.

---

### Task 1: Specify combined review behavior with one focused test

**Files:**
- Modify: `src/agent/life-journal.test.ts`

**Step 1: Write the failing test**

Add one test whose fake reviewer returns a structured result containing `memoryCandidates`, `journalMarkdown`, and `agendaMarkdown`. Inject a maintenance spy, drain the runtime, and assert:

- the Journal and Agenda are written;
- `memory/people/<id>.md` contains one recent entry with content and source Message row ID;
- maintenance is enqueued for the new file;
- running the same candidate again with `minWriteIntervalMs: 0` deduplicates it and does not enqueue maintenance twice.

**Step 2: Run the focused test and verify failure**

Run:

```bash
pnpm test -- src/agent/life-journal.test.ts
```

Expected: the new test fails because the review schema currently drops `memoryCandidates` and no Memory file is created.

**Step 3: Commit the failing test only after implementation is green**

Keep the test unstaged until Task 2 completes so the main branch is never committed red.

### Task 2: Persist bounded recent Memory candidates

**Files:**
- Modify: `src/agent/life-journal.ts`
- Modify: `src/agent/life-journal.test.ts`

**Step 1: Extend the structured result minimally**

Add a Zod candidate schema with:

```ts
{
  scope: 'self' | 'person' | 'group' | 'topic'
  id?: string
  title?: string
  content: string
  sourceMessageIds?: number[]
}
```

Limit the array to three candidates and default it to `[]` so existing structured results and `SKIP`/`RECORD` fallbacks remain compatible.

**Step 2: Update reviewer instructions**

Tell the reviewer to return only durable facts, preferences, verified methods, or stable conclusions; exclude chatter, one-off events, rumors, temporary plans, and evolving research. State that person/group require an explicit ID, topic requires a stable title, content must be paraphrased, and only real source Message row IDs may be included.

**Step 3: Write candidates through the existing store**

Add optional `memoryMaintenance` to `createLifeJournalRuntime` dependencies. For each parsed candidate:

```ts
const result = await writeMemoryEntry(storeOptions, candidate)
if (result.created) memoryMaintenance?.enqueue(result.file)
```

Catch candidate failures individually, log bounded metadata, and continue. Count candidates, created entries, deduplications, and failures in `life_journal_review_completed`. Do not change `LifeJournalReviewResult` or append review output to `AgentContext`.

**Step 4: Run the focused tests and verify green**

Run:

```bash
pnpm test -- src/agent/life-journal.test.ts src/agent/memory-store.test.ts src/agent/memory-maintenance.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/life-journal.ts src/agent/life-journal.test.ts
git commit -m "feat: 复用生活审阅抽取长期记忆"
```

### Task 3: Wire production maintenance and document the behavior

**Files:**
- Modify: `src/index.ts`
- Modify: `docs/MEMORY_ARCHITECTURE.md`
- Modify: `docs/TOOLS.md`

**Step 1: Wire the dependency**

Create `memoryMaintenance` before `lifeJournal` in `src/index.ts` and pass it into `createLifeJournalRuntime`. Continue sharing the existing disabled-thinking LLM client, task scheduler, and workspace coordinator.

**Step 2: Update documentation**

Document that the ten-minute Life review may emit up to three recent Memory candidates in the same call, that new entries enter existing maintenance, and that recall remains explicit. Do not describe it as hidden recall or ledger reconstruction.

**Step 3: Run static and repository verification**

Run:

```bash
pnpm typecheck
pnpm repo-check
git diff --check
```

Expected: typecheck and diff check pass. If `repo-check` still reports the pre-existing system-prompt disclosure anchors, record that separately and do not broaden this feature to fix them.

**Step 4: Run the focused regression set**

Run:

```bash
pnpm test -- src/agent/life-journal.test.ts src/agent/bot-loop-agent.test.ts src/agent/memory-store.test.ts src/agent/memory-maintenance.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/index.ts docs/MEMORY_ARCHITECTURE.md docs/TOOLS.md
git commit -m "docs: 记录统一状态抽取流程"
```
