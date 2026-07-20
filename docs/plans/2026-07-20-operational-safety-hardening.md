# Operational Safety Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Isolate test observability data, replace the misleading reset command with explicit safe scopes, and add configurable best-effort retention for observability tables and NDJSON logs.

**Architecture:** Keep the existing single-process startup flow. Test isolation is established before application imports; metrics filters share one default mock-exclusion contract across log and DB sources; reset uses one scope-aware operation with context and knowledge boundaries; observability retention runs after the existing fact-ledger retention and isolates failures per target.

**Tech Stack:** TypeScript ESM, Node test runner, Prisma/PostgreSQL, Node filesystem APIs, pnpm.

---

### Task 1: Isolate test logs and exclude mock metrics by default

**Files:**
- Modify: `scripts/test-env.mjs`
- Modify: `src/ops/agent-metrics.ts`
- Modify: `src/ops/agent-metrics.test.ts`
- Modify: `src/ops/agent-observability-db.ts`
- Modify: `src/ops/agent-observability-db.test.ts`
- Modify: `scripts/agent-metrics.ts`
- Create: `src/ops/test-environment.test.ts`

**Step 1: Write failing tests for the test environment**

Assert that the preloaded test environment has disabled repository app logging and redirected token/tool logs outside `logs/`:

```ts
test('isolates file-backed observability from repository logs', () => {
  assert.equal(process.env.LOG_FILE_ENABLED, 'false')
  assert.equal(process.env.BOT_TOKEN_USAGE_LOG_PATH?.includes('/logs/'), false)
  assert.equal(process.env.BOT_TOOL_CALL_LOG_PATH?.includes('/logs/'), false)
})
```

**Step 2: Run the environment test and verify it fails**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/test-environment.test.ts`

Expected: FAIL because `LOG_FILE_ENABLED` and isolated paths are not configured.

**Step 3: Write failing metrics tests**

Add one log summary case containing real and mock records. Expect mock to be excluded when no model is requested and included when `model: 'mock'` is explicit. Add equivalent SQL-shape assertions so the DB source receives `model: { notIn: ['mock'] }` only for the default query.

**Step 4: Run focused metrics tests and verify they fail**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/agent-metrics.test.ts src/ops/agent-observability-db.test.ts`

Expected: FAIL because mock rows are currently included by default.

**Step 5: Implement the minimal isolation and filter contract**

In `scripts/test-env.mjs`, use `node:os` and `node:path` to create process-specific paths under `tmpdir()` and set:

```js
LOG_FILE_ENABLED: 'false',
BOT_TOKEN_USAGE_LOG_PATH: join(testLogDir, 'token-usage.ndjson'),
BOT_TOOL_CALL_LOG_PATH: join(testLogDir, 'tool-calls.ndjson'),
BOT_FETCH_LOG_PATH: join(testLogDir, 'fetch.ndjson'),
```

Extend `AgentMetricsFilters` with `excludedModels?: readonly string[]`. Normalize filters so the default is `['mock']`, but an explicit `model` disables the default exclusion. Apply the same normalized filter to NDJSON aggregation and persisted DB query construction.

**Step 6: Run focused tests and verify they pass**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/test-environment.test.ts src/ops/agent-metrics.test.ts src/ops/agent-observability-db.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add scripts/test-env.mjs scripts/agent-metrics.ts src/ops/test-environment.test.ts src/ops/agent-metrics.ts src/ops/agent-metrics.test.ts src/ops/agent-observability-db.ts src/ops/agent-observability-db.test.ts
git commit -m "fix: 隔离测试日志并排除模拟指标"
```

### Task 2: Replace reset-memory with explicit reset-state scopes

**Files:**
- Create: `src/ops/reset-agent-state.ts`
- Create: `src/ops/reset-agent-state.test.ts`
- Create: `scripts/reset-agent-state.ts`
- Delete: `src/ops/reset-agent-memory.ts`
- Delete: `src/ops/reset-agent-memory.test.ts`
- Delete: `scripts/reset-agent-memory.ts`
- Modify: `package.json`

**Step 1: Write failing scope tests**

Define `AgentStateResetScope = 'all' | 'context' | 'knowledge'`. Add tests proving:

- `context` deletes ledger/checkpoint/runtime/Goal and recreates runtime, without deleting directories.
- `knowledge` deletes the four managed directories without opening a DB transaction.
- `all` performs both groups.
- repeated operations are idempotent.

Use a fake DB whose `$transaction` records calls and fails the test if invoked for `knowledge`.

**Step 2: Run the reset test and verify it fails**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/reset-agent-state.test.ts`

Expected: FAIL because the scope-aware module does not exist.

**Step 3: Implement the scope-aware operation**

Create:

```ts
export type AgentStateResetScope = 'all' | 'context' | 'knowledge'

export async function resetAgentState(options: {
  scope: AgentStateResetScope
  db?: AgentStateResetDb
  workspaceDir: string
}): Promise<AgentStateResetResult>
```

Require `db` only for `all|context`. Keep the current DB transaction and empty runtime shape unchanged. Only `all|knowledge` remove `memory`, `journal`, `life`, and `notebook`.

**Step 4: Implement strict CLI parsing**

The new script must require both `--confirm` and exactly one valid `--scope`. It must check `.bot.pid` before either DB or filesystem mutation. It should connect Prisma only for `all|context`.

**Step 5: Replace the package entry and remove legacy files**

Replace:

```json
"agent:reset-memory": "tsx scripts/reset-agent-memory.ts --confirm"
```

with:

```json
"agent:reset-state": "tsx scripts/reset-agent-state.ts --confirm"
```

Do not retain a compatibility alias.

**Step 6: Run focused tests and verify they pass**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/reset-agent-state.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add package.json scripts/reset-agent-state.ts src/ops/reset-agent-state.ts src/ops/reset-agent-state.test.ts
git add -u scripts/reset-agent-memory.ts src/ops/reset-agent-memory.ts src/ops/reset-agent-memory.test.ts
git commit -m "fix: 为状态重置增加显式范围"
```

### Task 3: Add observability retention configuration and database cleanup

**Files:**
- Modify: `src/config/index.ts`
- Modify: `src/config/index.test.ts`
- Create: `src/ops/observability-retention.ts`
- Create: `src/ops/observability-retention.test.ts`

**Step 1: Write failing configuration tests**

Expect `observabilityRetentionDays` to default to `30`, accept a positive integer, accept `0` as disabled, and reject negative, fractional, or non-numeric values from `BOT_OBSERVABILITY_RETENTION_DAYS`.

**Step 2: Run config tests and verify they fail**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/config/index.test.ts`

Expected: FAIL because the configuration property does not exist.

**Step 3: Write failing database retention tests**

Create a fake store:

```ts
interface ObservabilityRetentionStore {
  deleteToolCallsBefore(cutoff: Date): Promise<number>
  deleteTokenUsageBefore(cutoff: Date): Promise<number>
}
```

Verify a 30-day local-midnight cutoff, `0` disabling all work, and independent failure handling so one table failure does not skip the other.

**Step 4: Run the retention test and verify it fails**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/observability-retention.test.ts`

Expected: FAIL because the module does not exist.

**Step 5: Implement configuration and best-effort DB cleanup**

Add a strict non-negative integer parser and return `observabilityRetentionDays` from config. In the retention module, implement Prisma `deleteMany({ where: { ts: { lt: cutoff } } })` for both tables. Catch and report each target error independently; never throw from the top-level observability cleanup.

**Step 6: Run focused tests and verify they pass**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/config/index.test.ts src/ops/observability-retention.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/config/index.ts src/config/index.test.ts src/ops/observability-retention.ts src/ops/observability-retention.test.ts
git commit -m "feat: 增加观测数据保留策略"
```

### Task 4: Add atomic NDJSON pruning and startup wiring

**Files:**
- Modify: `src/ops/observability-retention.ts`
- Modify: `src/ops/observability-retention.test.ts`
- Modify: `src/index.ts`

**Step 1: Write failing NDJSON tests**

Use temporary files to verify:

- records older than cutoff are removed using `ts` or `time`.
- current records remain byte-for-byte.
- missing/invalid timestamps and invalid JSON remain and increment warnings.
- a missing file is a successful no-op.
- duplicate configured paths are processed once.
- one file failure does not prevent other files or DB targets.

**Step 2: Run the retention test and verify it fails**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/observability-retention.test.ts`

Expected: FAIL because NDJSON pruning is not implemented.

**Step 3: Implement atomic file replacement**

Read each configured file line-by-line, write retained original lines to a same-directory temporary file, then `rename` over the source. On error, best-effort remove the temporary file. Preserve malformed lines and emit a structured warning count.

**Step 4: Wire startup cleanup**

After `purgeOldData()`, invoke observability cleanup with:

```ts
await purgeObservabilityData({
  retentionDays: config.observabilityRetentionDays,
  ndjsonPaths: [config.tokenUsageLogPath, config.toolCallLogPath, config.fetchLogPath],
})
```

The function itself contains all best-effort isolation, so startup continues after failures.

**Step 5: Run focused tests and verify they pass**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/observability-retention.test.ts src/index.test.ts`

Expected: PASS. If `src/index.test.ts` does not directly exercise this call, rely on the retention unit tests plus typecheck and avoid starting real services.

**Step 6: Commit**

```bash
git add src/ops/observability-retention.ts src/ops/observability-retention.test.ts src/index.ts
git commit -m "feat: 启动时清理过期观测日志"
```

### Task 5: Update contracts and retire completed debt

**Files:**
- Modify: `.env.example`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/MEMORY_ARCHITECTURE.md`
- Modify: `docs/TECH_DEBT.md`
- Modify: `src/ops/repo-check.ts`
- Modify: `src/ops/repo-check.test.ts`

**Step 1: Write failing repository checks**

Require `BOT_OBSERVABILITY_RETENTION_DAYS` in `.env.example`, require the `agent:reset-state` package script, and reject a live `agent:reset-memory` script entry.

**Step 2: Run repo-check tests and verify they fail**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/repo-check.test.ts`

Expected: FAIL until the repository contracts are updated.

**Step 3: Update documentation and examples**

Document the three reset scopes, the 30-day default, `0` disable behavior, best-effort observability cleanup, malformed-line preservation, and test log isolation. Remove the three completed debt bullets while preserving unrelated debt and conditional observations.

**Step 4: Run repository checks**

Run: `pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/repo-check.test.ts && pnpm repo-check`

Expected: PASS.

**Step 5: Commit**

```bash
git add .env.example docs/OPERATIONS.md docs/MEMORY_ARCHITECTURE.md docs/TECH_DEBT.md src/ops/repo-check.ts src/ops/repo-check.test.ts
git commit -m "docs: 更新状态重置与保留策略"
```

### Task 6: Full verification

**Files:**
- Verify only

**Step 1: Run the full test suite**

Run: `pnpm test`

Expected: 0 failures. Confirm the command does not update repository-local app/token/tool logs.

**Step 2: Run static verification**

Run: `pnpm typecheck && pnpm repo-check && git diff --check`

Expected: all commands exit 0.

**Step 3: Inspect final scope**

Run: `git status --short && git log --oneline -7`

Expected: only the pre-existing unrelated untracked plan remains outside committed work; no generated workspace or log artifacts are staged.
