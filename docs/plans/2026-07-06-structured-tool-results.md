# Structured Tool Results Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace string-parsed control signals and machine-actionable prose with explicit runtime metadata and valid bounded JSON results.

**Architecture:** Extend `ToolExecutionResult` with runtime-only `outcome` and `control` metadata while keeping `content` as the sole AgentContext payload. Convert cross-tool handoffs and runtime events to deterministic JSON, but retain summaries and reference prose as strings inside explicit fields.

**Tech Stack:** TypeScript, Zod, Node test runner, Prisma, Markdown prompt templates.

---

### Task 1: Add runtime result metadata

**Files:**
- Modify: `src/agent/tool.ts`
- Modify: `src/agent/tool.test.ts`

**Step 1: Write failing tests**

Add tests proving that an explicit `outcome: { ok: false, code, error }` controls tool-call audit classification even when `content` is ordinary prose, and that thrown exceptions produce JSON content plus a failed outcome.

**Step 2: Verify RED**

Run: `node --env-file=.env --import tsx --test src/agent/tool.test.ts`

Expected: FAIL because `ToolExecutionResult` has no outcome and exception results omit it.

**Step 3: Implement the result contract**

Add:

```ts
export interface ToolExecutionOutcome {
  ok: boolean
  code?: string
  error?: string
}

export type ToolControl = { type: 'pause' }

export interface ToolExecutionResult {
  content: ToolResultContent
  outcome?: ToolExecutionOutcome
  control?: ToolControl
}
```

Make executor-generated unknown-tool, invalid-arguments, hook-failure, and exception results include failed outcomes. Update trace classification to use `result.outcome` first and retain content parsing only for untouched tools.

**Step 4: Verify GREEN**

Run the Task 1 test command and expect zero failures.

### Task 2: Remove pause string parsing

**Files:**
- Modify: `src/agent/tools/rest.ts`
- Modify: `src/agent/tools/rest.test.ts`
- Modify: `src/agent/bot-loop-agent.ts`
- Modify: `src/agent/bot-loop-agent.test.ts`

**Step 1: Write failing tests**

Assert that elapsed and interrupted pause results return parseable JSON with:

```json
{"ok":true,"status":"elapsed|interrupted","durationSeconds":30,"elapsedMs":0,"intention":"..."}
```

and `control: {type:'pause'}`. Add a BotLoop test whose pause content does not start with `[休息` but whose control metadata still sets `didPause=true`.

**Step 2: Verify RED**

Run: `node --env-file=.env --import tsx --test src/agent/tools/rest.test.ts src/agent/bot-loop-agent.test.ts`

Expected: FAIL on the old natural-language results and prefix parser.

**Step 3: Implement**

Return JSON content, explicit successful outcome, and pause control from both rest branches. Replace `result.content.startsWith('[休息')` with `result.control?.type === 'pause'`.

**Step 4: Verify GREEN**

Run the Task 2 command and expect zero failures.

### Task 3: Structure runtime event notifications

**Files:**
- Modify: `src/agent/mailbox.ts`
- Modify: `src/agent/mailbox.test.ts`
- Modify: `src/agent/render-event.ts`
- Modify: `src/agent/render-event.test.ts`
- Modify: `prompts/bot-system.md`
- Modify: `src/agent/bot-system-prompt.test.ts`

**Step 1: Write failing tests**

Parse mailbox notification output as JSON and assert stable fields: `event`, `mailbox`, `priority`, `source`, `count`, `firstRowId`, `throughRowId`, `senderCount`, `timeRange`, and exact `readArgs`. Parse background completion output and assert `event`, `taskId`, `toolName`, `ok`, `elapsedMs`, `description`, and `summary`.

**Step 2: Verify RED**

Run: `node --env-file=.env --import tsx --test src/agent/mailbox.test.ts src/agent/render-event.test.ts src/agent/bot-system-prompt.test.ts`

Expected: FAIL because notifications are bracketed prose.

**Step 3: Implement**

Use one `JSON.stringify` call over object literals with stable property order. Update system prompt examples and instructions to reference `readArgs` and `throughRowId`, without embedding dynamic state in the resident prompt.

**Step 4: Verify GREEN**

Run the Task 3 command and expect zero failures.

### Task 4: Make web search JSON bounded and valid

**Files:**
- Modify: `src/agent/tools/web-search.ts`
- Create or modify: `src/agent/tools/web-search.test.ts`

**Step 1: Write failing tests**

Inject or expose a pure formatter test with oversized results. Assert output is parseable JSON, contains `ok:true`, `source:'web_search'`, `results[]`, and `truncated:true`, and stays within the output cap. Assert failures include `ok:false` and failed outcome.

**Step 2: Verify RED**

Run: `node --env-file=.env --import tsx --test src/agent/tools/web-search.test.ts`

Expected: FAIL because serialized JSON is currently sliced mid-document and success lacks an envelope.

**Step 3: Implement**

Bound title, URL, and snippet fields before serialization; remove trailing entries until the final JSON fits. Never slice the serialized JSON. Return explicit outcomes.

**Step 4: Verify GREEN**

Run the Task 4 command and expect zero failures.

### Task 5: Structure URL and Reddit results

**Files:**
- Modify: `src/agent/tools/fetch-url.ts`
- Modify: `src/agent/tools/fetch-url.test.ts`
- Modify: `src/agent/tools/reddit/list.ts`
- Modify: `src/agent/tools/reddit/list.test.ts`
- Modify: `src/agent/tools/reddit/get-post.ts`
- Modify: `src/agent/tools/reddit/get-post.test.ts`

**Step 1: Write failing tests**

For every success, HTTP failure, network failure, empty response, parse failure, and summarizer fallback, assert valid JSON with stable `ok`, `source`, `code`, `error`, `truncated`, and structured result fields. Reddit list must return `items[]`; Reddit post must return `comments[]` and an optional `imageUrl`.

**Step 2: Verify RED**

Run: `node --env-file=.env --import tsx --test src/agent/tools/fetch-url.test.ts src/agent/tools/reddit/list.test.ts src/agent/tools/reddit/get-post.test.ts`

Expected: FAIL because current results are formatted prose.

**Step 3: Implement**

Replace bracketed status strings with bounded JSON payloads and explicit outcomes. Preserve summary/comment prose inside fields. Bound individual fields and arrays before `JSON.stringify`.

**Step 4: Verify GREEN**

Run the Task 5 command and expect zero failures.

### Task 6: Structure sticker pool results and compaction injection

**Files:**
- Modify: `src/agent/sticker-pool.ts`
- Modify: `src/agent/sticker-pool.test.ts`
- Modify: `src/agent/tools/collect-sticker.ts`
- Modify: `src/agent/tools/collect-sticker.test.ts`

**Step 1: Write failing tests**

Assert collect results are a single valid JSON object with `action:'collect'`, `sticker:{stickerId,mediaId,mediaRef}`, and `pool.stickers[]`. Assert compaction injection is valid JSON and never uses `#<mediaId>` as a machine reference.

**Step 2: Verify RED**

Run: `node --env-file=.env --import tsx --test src/agent/sticker-pool.test.ts src/agent/tools/collect-sticker.test.ts`

Expected: FAIL because collect appends Markdown to JSON and compaction injects a prose list.

**Step 3: Implement**

Create a shared bounded sticker-pool payload containing `mediaId`, `mediaRef`, name, tags, and description. Serialize it for compaction injection and reuse it in collect/list/search/random results.

**Step 4: Verify GREEN**

Run the Task 6 command and expect zero failures.

### Task 7: Wrap command outputs

**Files:**
- Modify: `src/agent/tools/workspace-bash.ts`
- Modify: `src/agent/tools/workspace-bash.test.ts`
- Modify: `src/agent/tools/openbb-cli.ts`
- Modify: `src/agent/tools/openbb-cli.test.ts`

**Step 1: Write failing tests**

Assert successful and failed commands return valid JSON envelopes containing `ok`, `exitCode`, `format`, `content`, `stderr`, and `truncated` as applicable. Verify command output remains bounded and explicit outcomes match the envelope.

**Step 2: Verify RED**

Run: `node --env-file=.env --import tsx --test src/agent/tools/workspace-bash.test.ts src/agent/tools/openbb-cli.test.ts`

Expected: FAIL because successful commands currently return raw stdout.

**Step 3: Implement**

Wrap command output without interpreting arbitrary stdout. Preserve existing allowlists, workspace boundaries, timeout behavior, fetch/style/db routing, and audit logging.

**Step 4: Verify GREEN**

Run the Task 7 command and expect zero failures.

### Task 8: Documentation and complete verification

**Files:**
- Modify: `docs/AGENT_CONTEXT.md`
- Modify: `docs/TOOLS.md`
- Modify: `docs/ARCHITECTURE.md` only if event rendering description changes materially

**Step 1: Update contracts**

Document runtime-only outcome/control metadata, structured event JSON, external-result envelopes, sticker payloads, and command envelopes. Do not duplicate complete schemas or volatile defaults.

**Step 2: Run focused suites together**

Run all test files touched in Tasks 1-7 with `node --env-file=.env --import tsx --test ...`.

Expected: zero failures.

**Step 3: Run repository verification**

Run local equivalents of:

```bash
pnpm test
pnpm typecheck
pnpm repo-check
git diff --check
```

If the local pnpm dependency-state hook blocks execution, use `node --env-file=.env --import tsx --test 'src/**/*.test.ts'`, `./node_modules/.bin/tsc --noEmit`, and `node --import tsx scripts/repo-check.ts`, and report the substitution.

Expected: all tests and checks pass with zero failures.
