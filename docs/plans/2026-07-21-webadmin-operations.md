# WebAdmin Management Operations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a localhost-only WebAdmin management page that previews, confirms, runs, and audits the four fixed Agent state maintenance operations.

**Architecture:** CLI and WebAdmin share typed functions under `src/ops`; no browser input can select a command, path, or shell argument. A server-only adapter builds previews and executes operations, while a single-flight runner persists bounded run state and NDJSON audit events under `logs/`. Every execution repeats the Bot-stopped guard and preview fingerprint check before mutation.

**Tech Stack:** TypeScript ESM, Node.js, Prisma, TanStack Start/Router/Query, React 19, Zod 4, Vitest, Node test runner.

---

### Task 1: Share the Bot-stopped guard across CLI and WebAdmin

**Files:**
- Create: `src/ops/bot-process-guard.ts`
- Create: `src/ops/bot-process-guard.test.ts`
- Modify: `scripts/reset-agent-state.ts`
- Modify: `scripts/migrate-memory-v2.ts`
- Modify: `scripts/canonicalize-memory-files.ts`
- Modify: `scripts/migrate-long-term-state-language.ts`

**Step 1: Write the failing guard tests**

Test dependency-injected cases rather than touching the real process table:

```ts
test('blocks a live pid from the repository pidfile', async () => {
  const result = await inspectBotProcessGuard('/repo', {
    readPidFile: async () => '42',
    probePid: () => 'live',
    listProcesses: async () => [],
    removePidFile: async () => undefined,
  })
  assert.deepEqual(result, { stopped: false, pid: 42, reason: 'pidfile_live' })
})

test('removes a stale pidfile and checks ps fallback', async () => {
  let removed = false
  const result = await inspectBotProcessGuard('/repo', {
    readPidFile: async () => '42',
    probePid: () => 'missing',
    removePidFile: async () => { removed = true },
    listProcesses: async () => [{ pid: 51, command: 'node /repo/src/index.ts' }],
  })
  assert.equal(removed, true)
  assert.equal(result.stopped, false)
  assert.equal(result.reason, 'process_scan_match')
})
```

Also cover missing pidfile + empty process list, invalid pidfile, and `assertBotStopped` error text.

**Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/bot-process-guard.test.ts
```

Expected: FAIL because `bot-process-guard.ts` does not exist.

**Step 3: Implement the shared guard**

Expose a serializable inspection result and an assertion:

```ts
export type BotProcessGuardResult =
  | { stopped: true; pid: null; reason: 'no_process' }
  | { stopped: false; pid: number; reason: 'pidfile_live' | 'process_scan_match' }

export async function inspectBotProcessGuard(
  repositoryRoot: string,
  dependencies: BotProcessGuardDependencies = nodeDependencies(repositoryRoot),
): Promise<BotProcessGuardResult>

export async function assertBotStopped(repositoryRoot: string): Promise<void>
```

Use `readFile`, `unlink`, `process.kill(pid, 0)`, and `execFile('ps', ['-axo', 'pid=,command='])`; do not use a shell. Match only `tsx|node` commands containing the resolved repository root and `src/index.ts`.

**Step 4: Refactor all four CLI scripts**

Delete their local PID/`ps` implementations and call:

```ts
await assertBotStopped(resolve('.'))
```

Keep the existing rule that preview-only CLI commands do not require Bot shutdown.

**Step 5: Run focused and regression tests**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/ops/bot-process-guard.test.ts \
  src/ops/reset-agent-state.test.ts \
  src/ops/memory-v2-migration.test.ts \
  src/ops/memory-canonicalization.test.ts \
  src/ops/long-term-state-language-migration.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/ops/bot-process-guard.ts src/ops/bot-process-guard.test.ts \
  scripts/reset-agent-state.ts scripts/migrate-memory-v2.ts \
  scripts/canonicalize-memory-files.ts scripts/migrate-long-term-state-language.ts
git commit -m "refactor: 统一 Bot 停止检查"
```

### Task 2: Add a read-only reset preview

**Files:**
- Modify: `src/ops/reset-agent-state.ts`
- Modify: `src/ops/reset-agent-state.test.ts`

**Step 1: Write the failing preview tests**

Add a fake preview DB and temporary workspace. Assert that:

- `context` reports counts for ledger, checkpoint, runtime, and Goal without mutation.
- `knowledge` reports `memory`, `journal`, `life`, and `notebook` existence/file counts.
- `all` combines both sections.
- preview never starts a transaction or removes a path.

Expected DTO:

```ts
{
  scope: 'all',
  context: { ledgerEntries: 7, checkpoints: 1, runtimeStates: 1, goals: 1 },
  knowledge: {
    directories: [
      { name: 'memory', exists: true, files: 2 },
      { name: 'journal', exists: false, files: 0 },
      { name: 'life', exists: true, files: 1 },
      { name: 'notebook', exists: true, files: 1 },
    ],
  },
}
```

**Step 2: Run the focused test and verify RED**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/reset-agent-state.test.ts
```

Expected: FAIL because `previewAgentStateReset` is missing.

**Step 3: Implement the preview port and function**

Add:

```ts
export interface AgentStateResetPreviewDb {
  botAgentLedgerEntry: { count(): Promise<number> }
  botAgentCheckpoint: { count(): Promise<number> }
  botAgentRuntimeState: { count(): Promise<number> }
  botAgentGoal: { count(): Promise<number> }
}

export async function previewAgentStateReset(options: {
  scope: AgentStateResetScope
  db?: AgentStateResetPreviewDb
  workspaceDir: string
}): Promise<AgentStateResetPreview>
```

Use bounded recursive file counting under the four fixed directories. Do not accept arbitrary directory names and do not create missing paths.

**Step 4: Run tests and verify GREEN**

Run the Task 2 command again. Expected: PASS.

**Step 5: Commit**

```bash
git add src/ops/reset-agent-state.ts src/ops/reset-agent-state.test.ts
git commit -m "feat: 增加状态重置预览"
```

### Task 3: Make the Chinese migration previewable and reusable

**Files:**
- Modify: `src/ops/long-term-state-language-migration.ts`
- Modify: `src/ops/long-term-state-language-migration.test.ts`
- Create: `src/ops/long-term-state-language-translator.ts`
- Create: `src/ops/long-term-state-language-translator.test.ts`
- Modify: `scripts/migrate-long-term-state-language.ts`

**Step 1: Write a failing zero-write preview test**

Build the same fixture used by the migration test, snapshot all files, call the new planner, then assert byte-for-byte equality afterward:

```ts
const preview = await planLongTermStateLanguageMigration({ rootDir })
assert.equal(preview.totalItems, 6)
assert.deepEqual(preview.counts, {
  memoryTitles: 1,
  memoryEntries: 1,
  notebookTopics: 1,
  notebookEntries: 1,
  lifeJournalEntries: 1,
  agendaItems: 1,
})
assert.deepEqual(await snapshotTree(rootDir), before)
```

Also test an already-Chinese workspace returns `totalItems: 0`.

**Step 2: Run the migration test and verify RED**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/long-term-state-language-migration.test.ts
```

Expected: FAIL because the planning export does not exist.

**Step 3: Extract the read-only plan**

Add a public plan type containing bounded category counts and translation items:

```ts
export interface LongTermStateLanguageMigrationPlan {
  totalItems: number
  estimatedBatches: number
  counts: LongTermStateLanguageMigrationCounts
  items: readonly LongTermTranslationItem[]
}

export async function planLongTermStateLanguageMigration(input: {
  rootDir: string
}): Promise<LongTermStateLanguageMigrationPlan>
```

Reuse the existing collectors. The public Web preview later serializes counts only; raw item text remains server-side. `migrateLongTermStateToChinese` should reuse the same collector after its existing backup/repair stage.

**Step 4: Extract the LLM translator from the CLI**

Move `SYSTEM_PROMPT`, batching, schema validation, and retry logic into `long-term-state-language-translator.ts`:

```ts
export function createLongTermStateTranslator(llm: LlmClient): (
  items: readonly LongTermTranslationItem[],
  onProgress?: (progress: { completedBatches: number; totalBatches: number }) => void,
) => Promise<readonly LongTermTranslation[]>
```

Inject a fake `LlmClient` in tests. Cover valid tool output, one invalid response followed by a valid retry, and two invalid responses.

**Step 5: Make the CLI use the shared translator**

The script should only parse arguments, assert Bot stopped, construct `createLlmClient()`, and invoke the shared migration/translator. Remove the duplicated tool/schema/prompt implementation from `scripts/`.

**Step 6: Run focused tests**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/ops/long-term-state-language-migration.test.ts \
  src/ops/long-term-state-language-translator.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/ops/long-term-state-language-migration.ts \
  src/ops/long-term-state-language-migration.test.ts \
  src/ops/long-term-state-language-translator.ts \
  src/ops/long-term-state-language-translator.test.ts \
  scripts/migrate-long-term-state-language.ts
git commit -m "refactor: 复用长期状态中文迁移服务"
```

### Task 4: Define the fixed operation DTO and use-case service

**Files:**
- Create: `apps/admin-web/src/features/operations/operations.schema.ts`
- Create: `apps/admin-web/src/features/operations/operations.service.ts`
- Create: `apps/admin-web/src/features/operations/operations.service.test.ts`

**Step 1: Write failing schema and service tests**

Cover the exact operation union:

```ts
const operationRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('reset_state'), scope: z.enum(['context', 'knowledge', 'all']) }),
  z.object({ operation: z.literal('migrate_memory_v2') }),
  z.object({ operation: z.literal('canonicalize_memory') }),
  z.object({ operation: z.literal('migrate_state_language') }),
])
```

Assert that command names, paths, extra properties, and unknown operations are rejected. With a fake operations port, assert:

- preview canonicalization produces a stable SHA-256 fingerprint.
- reset confirmation phrases include the selected scope.
- migration preview with no changes returns `needed: false`.
- execute rejects a mismatched phrase, a stale fingerprint, and a running Bot.
- execute calls only the selected typed port method.

**Step 2: Run WebAdmin tests and verify RED**

```bash
pnpm web:test -- operations.service.test.ts
```

Expected: FAIL because the operations feature does not exist.

**Step 3: Implement strict cross-boundary DTOs**

Use `.strict()` on every object. Keep previews bounded:

- Memory v2: cap `changes` and `warnings` sent to the browser and include `truncated` counts.
- Canonicalization: fixed source/target string arrays.
- Language migration: category counts and batch estimate only, never raw translation text.
- Reset: counts and fixed directory names only.

Define `OperationPreview`, `OperationRun`, and snapshot schemas with ISO dates and string IDs.

**Step 4: Implement the pure use-case service**

Inject this port:

```ts
export interface AdminOperationsPort {
  inspectBot(): Promise<BotProcessStatusDto>
  preview(request: OperationRequest): Promise<OperationPreviewPayload>
  execute(request: OperationRequest, progress: OperationProgressReporter): Promise<OperationResultPayload>
}
```

The service owns confirmation phrase comparison, preview TTL, canonical JSON hashing, and stale-preview comparison. It must not import Node APIs, Prisma, or environment variables, so its behavior is easy to test.

**Step 5: Run tests and verify GREEN**

```bash
pnpm web:test -- operations.service.test.ts
pnpm web:typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/admin-web/src/features/operations/operations.schema.ts \
  apps/admin-web/src/features/operations/operations.service.ts \
  apps/admin-web/src/features/operations/operations.service.test.ts
git commit -m "feat: 定义 WebAdmin 管理操作协议"
```

### Task 5: Add the single-flight runner and bounded persistence

**Files:**
- Create: `apps/admin-web/src/features/operations/operation-runner.ts`
- Create: `apps/admin-web/src/features/operations/operation-runner.test.ts`
- Create: `apps/admin-web/src/features/operations/operation-run-store.server.ts`
- Create: `apps/admin-web/src/features/operations/operation-run-store.server.test.ts`

**Step 1: Write failing runner tests**

Use a deferred promise to keep the first run active:

```ts
const first = runner.start(validStart)
await assert.rejects(runner.start(secondStart), /operation_in_progress/)
deferred.resolve({ ok: true })
assert.equal((await first).status, 'succeeded')
```

Also cover progress updates, bounded safe errors, failure, and restoration of a persisted `running` record as `interrupted` when its writer PID differs.

**Step 2: Run and verify RED**

```bash
pnpm web:test -- operation-runner.test.ts
```

Expected: FAIL because the runner does not exist.

**Step 3: Implement the pure single-flight state machine**

The runner accepts an injected store, clock, ID generator, current PID, and executor. It persists each state transition and keeps only the latest 25 completed records in the snapshot. Result/error payloads must pass `operationRunSchema` before persistence.

Do not add cancellation in this phase: the underlying migrations are not abort-safe.

**Step 4: Write failing file-store tests**

Use a temporary directory to assert:

- state JSON is replaced atomically and validates its schema/version.
- each transition appends one compact NDJSON event.
- audit lines omit preview bodies and translation text.
- missing files produce an empty state; corrupt state fails closed.

**Step 5: Implement the server-only store**

Use fixed paths derived from repository root:

```text
logs/admin-operation-state.json
logs/admin-operations.ndjson
```

Write state through a same-directory temporary file plus rename. Append audit events with `appendFile`. Cap safe error text at 500 characters.

**Step 6: Run tests and typecheck**

```bash
pnpm web:test -- operation-runner.test.ts operation-run-store.server.test.ts
pnpm web:typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/admin-web/src/features/operations/operation-runner.ts \
  apps/admin-web/src/features/operations/operation-runner.test.ts \
  apps/admin-web/src/features/operations/operation-run-store.server.ts \
  apps/admin-web/src/features/operations/operation-run-store.server.test.ts
git commit -m "feat: 增加管理操作任务运行器"
```

### Task 6: Wire concrete operations and TanStack Server Functions

**Files:**
- Create: `apps/admin-web/src/features/operations/operations.server.ts`
- Create: `apps/admin-web/src/features/operations/operations.server.test.ts`
- Create: `apps/admin-web/src/features/operations/operations.functions.ts`
- Create: `apps/admin-web/src/features/operations/operations.query.ts`
- Modify: `apps/admin-web/src/server/server-boundary.test.ts`

**Step 1: Write failing concrete-adapter tests**

Inject fake Prisma, workspace root, repository root, LLM translator, and runner store. Verify each request maps exactly once:

- `reset_state` → `previewAgentStateReset` / `resetAgentState`.
- `migrate_memory_v2` → `migrateMemoryToV2({ apply: false|true })`.
- `canonicalize_memory` → `canonicalizeSelfTopicMemory({ apply: false|true })`.
- `migrate_state_language` → plan / migrate with progress.

Assert every execute checks `assertBotStopped` after preview validation and before the mutation call.

**Step 2: Run and verify RED**

```bash
pnpm web:test -- operations.server.test.ts
```

Expected: FAIL because the concrete adapter does not exist.

**Step 3: Implement `operations.server.ts`**

The first line must be:

```ts
import '@tanstack/react-start/server-only'
```

Build a lazily initialized module singleton for the runner. Derive roots with `getRepositoryRoot()` and `getWorkspaceRoot()`. Use `getAdminPrisma()` only for reset and Memory v2 evidence reads. Construct the LLM client only when the Chinese migration actually starts.

Never import a CLI script or call `exec`, `execFile`, `spawn`, or a shell.

**Step 4: Add strict Server Functions and query options**

Expose only:

```ts
getOperationsSnapshot   // GET
createOperationPreview  // POST, validated OperationRequest
startOperation          // POST, validated previewId + confirmation
getOperationRun         // GET, validated runId
```

Use TanStack Start input validators backed by the Zod schemas. Poll the snapshot every 1 second only while a run is `queued|running`, otherwise every 10 seconds.

**Step 5: Tighten the boundary test**

Replace the blanket mutation rule with a localized rule:

- no feature except `features/operations/operations.server.ts` may contain Prisma mutation markers.
- `operations.server.ts` may call `resetAgentState`, but must not contain generic command execution markers.
- browser source restrictions remain unchanged.

**Step 6: Run focused tests and build**

```bash
pnpm web:test -- operations.server.test.ts server-boundary.test.ts
pnpm web:typecheck
pnpm web:build
```

Expected: PASS; build performs no live database connection or operation execution.

**Step 7: Commit**

```bash
git add apps/admin-web/src/features/operations/operations.server.ts \
  apps/admin-web/src/features/operations/operations.server.test.ts \
  apps/admin-web/src/features/operations/operations.functions.ts \
  apps/admin-web/src/features/operations/operations.query.ts \
  apps/admin-web/src/server/server-boundary.test.ts
git commit -m "feat: 接入 WebAdmin 管理操作服务"
```

### Task 7: Build the management page

**Files:**
- Create: `apps/admin-web/src/features/operations/OperationsView.tsx`
- Create: `apps/admin-web/src/features/operations/OperationsView.test.tsx`
- Create: `apps/admin-web/src/routes/operations.tsx`
- Modify: `apps/admin-web/src/components/AdminShell.tsx`
- Modify: `apps/admin-web/src/styles.css`
- Modify (generated): `apps/admin-web/src/routeTree.gen.ts`

**Step 1: Write failing view tests**

Render the component with callbacks and verify:

- four fixed cards are present and no command/path text field exists.
- Memory v2/canonicalize cards display “无需执行” and disable execution when preview says `needed: false`.
- a live Bot displays the block reason and disables execution.
- reset shows an irreversible warning and scope-specific confirmation phrase.
- a stale preview error asks for a new preview.
- running progress, success backup path, failure, and interrupted states render distinctly.

Use `userEvent` only if already available; otherwise `fireEvent` from Testing Library to avoid adding a dependency.

**Step 2: Run and verify RED**

```bash
pnpm web:test -- OperationsView.test.tsx
```

Expected: FAIL because the view does not exist.

**Step 3: Implement the page as a DTO-only component**

Use existing `PageHeader`, `Panel`, `StatusBadge`, `WarningList`, and formatting helpers. Keep dangerous controls visually separate from observation data. The execute button remains disabled until:

- preview is current and `needed` is true,
- Bot status is stopped,
- confirmation matches exactly,
- no run is active.

Do not display raw translation items, memory contents, or database payloads.

**Step 4: Add the route and query/mutation wiring**

The route loader fetches the initial snapshot. Component mutations invalidate `['operations']` queries and begin polling the returned run ID.

Generate the route tree:

```bash
pnpm --filter @qq-bot/admin-web generate-routes
```

**Step 5: Split shell navigation into observation and management sections**

Add `/operations` with a tools/settings icon. Replace global “只读”/“无写入与控制操作” claims with “本机管理模式”; retain descriptions on observation pages that their data paths are read-only.

**Step 6: Run view tests, typecheck, and build**

```bash
pnpm web:test -- OperationsView.test.tsx AdminUi.test.tsx OverviewView.test.tsx
pnpm web:typecheck
pnpm web:build
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/admin-web/src/features/operations/OperationsView.tsx \
  apps/admin-web/src/features/operations/OperationsView.test.tsx \
  apps/admin-web/src/routes/operations.tsx \
  apps/admin-web/src/components/AdminShell.tsx \
  apps/admin-web/src/styles.css \
  apps/admin-web/src/routeTree.gen.ts
git commit -m "feat: 增加 WebAdmin 管理操作页面"
```

### Task 8: Update repository contracts and operational documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `apps/admin-web/AGENTS.md`
- Modify: `apps/admin-web/CLAUDE.md`
- Modify: `docs/README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`

**Step 1: Update the local WebAdmin contract**

Replace “first phase all read-only” with the precise boundary:

- observation features remain read-only;
- only the fixed operations feature may mutate;
- all mutations require preview, confirmation, Bot-stopped guard, single-flight runner, and audit;
- no generic shell/SQL/path input;
- still localhost-only without authentication.

Apply identical edits to each AGENTS/CLAUDE pair.

**Step 2: Update architecture and operations docs**

Document the new data flow separately from observation:

```text
Browser → validated Server Function → operation service
        → Bot-stopped guard → typed src/ops mutation
        → local run state/audit log
```

Document the four operations, confirmation behavior, log paths, interrupted semantics, backup behavior, and the rule that Bot must be stopped manually.

**Step 3: Run documentation and equality checks**

```bash
cmp -s AGENTS.md CLAUDE.md
cmp -s apps/admin-web/AGENTS.md apps/admin-web/CLAUDE.md
git diff --check
pnpm repo-check
```

Expected: all commands exit 0.

**Step 4: Commit**

```bash
git add AGENTS.md CLAUDE.md apps/admin-web/AGENTS.md apps/admin-web/CLAUDE.md \
  docs/README.md docs/ARCHITECTURE.md docs/OPERATIONS.md
git commit -m "docs: 更新 WebAdmin 管理边界"
```

### Task 9: Run full verification and review the completed change

**Files:**
- Modify only if verification exposes a defect.

**Step 1: Run all focused root tests**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/ops/bot-process-guard.test.ts \
  src/ops/reset-agent-state.test.ts \
  src/ops/memory-v2-migration.test.ts \
  src/ops/memory-canonicalization.test.ts \
  src/ops/long-term-state-language-migration.test.ts \
  src/ops/long-term-state-language-translator.test.ts
```

Expected: PASS.

**Step 2: Run complete WebAdmin verification**

```bash
pnpm web:test
pnpm web:typecheck
pnpm web:build
```

Expected: PASS.

**Step 3: Run repository verification**

```bash
pnpm typecheck
pnpm repo-check
git diff --check
```

Expected: PASS.

**Step 4: Inspect the final diff and repository state**

```bash
git status --short
git diff HEAD~8 --stat
git log -9 --oneline
```

Confirm that the pre-existing untracked `docs/plans/2026-07-13-architecture-doc-sync.md` remains untouched and uncommitted.

**Step 5: Perform code review**

Use `superpowers:requesting-code-review` and address any findings through `superpowers:receiving-code-review`. Re-run the smallest affected verification after each fix.

**Step 6: Commit verification fixes if needed**

```bash
git add <only-files-fixed-during-verification>
git commit -m "fix: 收紧 WebAdmin 管理操作边界"
```

Do not create an empty commit when no fix was necessary.
