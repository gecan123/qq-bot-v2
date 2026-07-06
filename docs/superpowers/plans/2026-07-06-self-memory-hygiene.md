# Self Memory Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded memory listing and permanent deletion, teach Luna to consolidate memory autonomously, then remove the superseded `memory/self` files.

**Architecture:** Keep filesystem invariants in `memory-store.ts`: listing returns metadata only, while deletion reuses the existing safe path resolver and reports per-file outcomes. `memory.ts` exposes typed `list` and `delete` actions; prompt text gives one resident hint and keeps the detailed workflow in `memory_hygiene`.

**Tech Stack:** TypeScript ESM, Node.js `fs/promises`, Zod, `node:test`, Markdown prompts and runtime skills.

---

### Task 1: Add bounded list and permanent delete to the memory store

**Files:**
- Modify: `src/agent/memory-store.ts`
- Test: `src/agent/memory-store.test.ts`

- [ ] **Step 1: Write failing store tests**

Add tests that create self/topic files, call `listMemoryFiles`, and assert scope filtering, `updatedAt` ordering, `sizeBytes`, total count and `truncated`. Add delete tests asserting successful permanent removal, `missing` for absent files, continued processing after a rejected `../escape.md`, and rejection of paths outside `memory/`.

```ts
const listed = await listMemoryFiles({ rootDir }, { scope: 'self', limit: 1 })
assert.equal(listed.ok, true)
assert.equal(listed.files[0]!.file, 'self/new.md')
assert.equal(listed.total, 2)
assert.equal(listed.truncated, true)

const deleted = await deleteMemoryFiles({ rootDir }, {
  files: ['self/old.md', 'self/missing.md', '../escape.md'],
})
assert.deepEqual(deleted.deleted, ['self/old.md'])
assert.deepEqual(deleted.missing, ['self/missing.md'])
assert.equal(deleted.failed[0]!.file, '../escape.md')
```

- [ ] **Step 2: Run the store test and verify failure**

Run: `node --import tsx --test src/agent/memory-store.test.ts`

Expected: FAIL because `listMemoryFiles` and `deleteMemoryFiles` are not exported.

- [ ] **Step 3: Implement minimal store operations**

Add `stat` and `unlink` imports, input/result types, and these functions:

```ts
export async function listMemoryFiles(
  options: MemoryStoreOptions,
  input: { scope?: MemoryScope; limit?: number } = {},
): Promise<MemoryListResult> {
  // Parse Markdown frontmatter, filter scope, stat each file, sort by updatedAt,
  // and return metadata only with total/truncated.
}

export async function deleteMemoryFiles(
  options: MemoryStoreOptions,
  input: { files: string[] },
): Promise<MemoryDeleteResult> {
  // Resolve every path through safeMemoryFile(), unlink it, report ENOENT as
  // missing, and collect other per-file errors without aborting the batch.
}
```

Use a store-level maximum of 100 list items. Preserve input order in `deleted`, `missing`, and `failed`.

- [ ] **Step 4: Run the store tests and verify pass**

Run: `node --import tsx --test src/agent/memory-store.test.ts`

Expected: all memory-store tests PASS.

### Task 2: Expose `list` and `delete` through the memory tool

**Files:**
- Modify: `src/agent/tools/memory.ts`
- Modify: `src/ops/tool-call-log.ts`
- Test: `src/agent/tools/memory.test.ts`
- Test: `src/agent/tool.test.ts`

- [ ] **Step 1: Write failing tool and side-effect tests**

Extend schema tests with:

```ts
assert.equal(memoryTool.schema.safeParse({ action: 'list', scope: 'self', limit: 50 }).success, true)
assert.equal(memoryTool.schema.safeParse({ action: 'delete', files: ['self/old.md'] }).success, true)
assert.equal(memoryTool.schema.safeParse({ action: 'delete', files: [] }).success, false)
assert.equal(memoryTool.schema.safeParse({ action: 'delete', files: ['../old.md'] }).success, false)
```

Extend execution tests to write two files, list them, delete one, and verify a subsequent read reports not found. Extend the tool trace test so both `write` and `delete` have `sideEffect: true`, while `search` and `list` remain false.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --import tsx --test src/agent/tools/memory.test.ts src/agent/tool.test.ts`

Expected: FAIL because the new actions are absent and delete is not classified as a side effect.

- [ ] **Step 3: Implement tool actions**

Add discriminated-union variants:

```ts
z.object({
  action: z.literal('list'),
  scope: scopeSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}),
z.object({
  action: z.literal('delete'),
  files: z.array(z.string().trim().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+\.md$/)).min(1).max(50),
}),
```

Dispatch to `listMemoryFiles` and `deleteMemoryFiles`, return stable JSON, set `outcome.ok` false only when the delete result contains failed entries, and log counts plus file paths without body content. Update the tool description with the new actions.

Change side-effect classification to:

```ts
if (toolName === 'memory') {
  return hasAnyAction(args, ['write', 'delete'])
}
```

- [ ] **Step 4: Run focused tests and verify pass**

Run: `node --import tsx --test src/agent/tools/memory.test.ts src/agent/tool.test.ts`

Expected: all selected tests PASS.

### Task 3: Add autonomous memory hygiene guidance

**Files:**
- Modify: `prompts/bot-system.md`
- Modify: `docs/agent-skills/memory_hygiene.md`
- Modify: `src/agent/bot-system-prompt.test.ts`
- Modify: `src/agent/tools/skill.test.ts`

- [ ] **Step 1: Write failing prompt and skill assertions**

Assert the resident prompt contains a short instruction matching `记忆.*重复.*整理`, and the loaded `memory_hygiene` skill mentions `memory list`, `memory delete`, writing the retained summary first, and avoiding fixed-time mechanical cleanup.

- [ ] **Step 2: Run prompt/skill tests and verify failure**

Run: `node --import tsx --test src/agent/bot-system-prompt.test.ts src/agent/tools/skill.test.ts`

Expected: FAIL because the hygiene workflow is not present.

- [ ] **Step 3: Update prompt and skill**

Add one sentence under `[自主生活]`:

```md
长期记忆开始重复、过时或难检索时，可以主动整理；不要为了整理而反复生成总结。
```

Expand `memory_hygiene.md` with the approved workflow: self-chosen timing, list/search/read, write the retained compact version, verify it, then permanently delete superseded files.

- [ ] **Step 4: Run prompt/skill tests and verify pass**

Run: `node --import tsx --test src/agent/bot-system-prompt.test.ts src/agent/tools/skill.test.ts`

Expected: all selected tests PASS.

### Task 4: Verify and clean current self memory

**Files:**
- Delete: `data/agent-workspace/memory/self/*.md` except `2026-07-06-全天终极精简版.md`

- [ ] **Step 1: Run the complete relevant verification set**

Run:

```bash
node --import tsx --test src/agent/memory-store.test.ts src/agent/tools/memory.test.ts src/agent/tool.test.ts src/agent/bot-system-prompt.test.ts src/agent/tools/skill.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsx scripts/repo-check.ts
git diff --check
```

Expected: tests PASS, typecheck PASS, repo-check PASS, diff check produces no output.

- [ ] **Step 2: Re-list self memory and inspect files newer than the retained summary**

Run a read-only listing ordered by modification time. Preserve `2026-07-06-全天终极精简版.md`; inspect any file created or updated after it before deleting.

- [ ] **Step 3: Permanently delete superseded files**

Delete only the reviewed files under `data/agent-workspace/memory/self/`. Do not touch other memory scopes or normal workspace content.

- [ ] **Step 4: Verify final filesystem state**

Run: `rg --files data/agent-workspace/memory/self | sort`

Expected: only `data/agent-workspace/memory/self/2026-07-06-全天终极精简版.md` remains unless a newer, non-superseded file was explicitly preserved during Step 2.
