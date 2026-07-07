# Life Journal Markdown Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Markdown-only Life Journal, Agenda, and bounded idle picker so Luna can maintain her own lived continuity without adding DB schema or rewriting architecture.

**Architecture:** Keep all durable state under `data/agent-workspace/life/`. Add a small store for bounded Markdown file operations, a self-review runtime that uses the existing `LlmClient` to let Luna write journal/agenda content, and optional BotLoop hooks so the feature does not disturb replay invariants. Idle picker reads `agenda.md` first and only bounded recent journal context when needed.

**Tech Stack:** TypeScript ESM, node:test, `fs/promises`, existing `LlmClient`, existing `BotLoopAgent`, existing `AgentContext` contracts.

---

### Task 1: Markdown Store

**Files:**
- Create: `src/agent/life-journal-store.ts`
- Test: `src/agent/life-journal-store.test.ts`

**Step 1: Write failing tests**

Cover these behaviors:

```ts
test("appends daily journal entries under life/journal", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "life-journal-"));
  await appendLifeJournalEntry({
    rootDir,
    now: () => new Date("2026-07-07T15:18:00.000Z"),
    roundIndex: 42,
    markdown: "### Saw\n- 用户确认方向。\n",
  });
  const raw = await readFile(join(rootDir, "life", "journal", "2026-07-07.md"), "utf8");
  assert.match(raw, /# Life Journal 2026-07-07/);
  assert.match(raw, /## 23:18 Round 42/);
});
```

Also test:

- `ensureLifeAgenda` creates `life/agenda.md` from a fixed template.
- `writeLifeAgenda` overwrites only `life/agenda.md`.
- `readRecentLifeJournalFiles({ days: 2 })` returns at most the latest two daily files.
- path helpers never accept caller-provided paths.

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm test -- src/agent/life-journal-store.test.ts
```

Expected: FAIL because `life-journal-store.ts` does not exist.

**Step 3: Implement minimal store**

Add these exported functions:

```ts
export interface LifeJournalStoreOptions {
  rootDir: string;
  now?: () => Date;
}

export async function appendLifeJournalEntry(
  options: LifeJournalStoreOptions & { roundIndex: number; markdown: string },
): Promise<{ path: string; heading: string }>;

export async function ensureLifeAgenda(options: LifeJournalStoreOptions): Promise<string>;
export async function readLifeAgenda(options: LifeJournalStoreOptions): Promise<string>;
export async function writeLifeAgenda(options: LifeJournalStoreOptions, markdown: string): Promise<void>;
export async function readRecentLifeJournalFiles(
  options: LifeJournalStoreOptions & { days: number },
): Promise<Array<{ path: string; content: string }>>;
```

Implementation notes:

- Use `join(rootDir, "life", ...)`.
- Daily journal path is `life/journal/YYYY-MM-DD.md`.
- Format timestamps in Asia/Shanghai with `HH:mm`.
- Create parent directories with `mkdir(..., { recursive: true })`.
- Keep template strings in this module for now; do not write dynamic prose into system prompt.

**Step 4: Run tests and verify pass**

Run:

```bash
pnpm test -- src/agent/life-journal-store.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/life-journal-store.ts src/agent/life-journal-store.test.ts
git commit -m "feat: add life journal markdown store"
```

### Task 2: Self-Review Runtime

**Files:**
- Create: `src/agent/life-journal.ts`
- Test: `src/agent/life-journal.test.ts`

**Step 1: Write failing tests**

Use a mock `LlmClient` that returns JSON inside plain text:

```ts
const llm: LlmClient = {
  async chat(input) {
    assert.equal(input.tools.length, 0);
    assert.match(input.systemPrompt, /Life Journal/);
    return {
      content: JSON.stringify({
        shouldWrite: true,
        journalMarkdown: "### Saw\n- 用户确认让我自己写。\n\n### Did\n- 形成计划。\n",
        agendaMarkdown: "# Agenda\n\n## Active\n- [ ] 继续设计\n",
      }),
      toolCalls: [],
      usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50 },
      model: "mock",
    };
  },
};
```

Assert:

- `recordRound` writes a journal entry when `shouldWrite=true`.
- `recordRound` updates agenda only when returned `agendaMarkdown` is non-empty.
- invalid JSON or empty content returns `{ ok:false }` and does not throw.
- the LLM input contains only bounded current-round messages, not the full `AgentContext`.

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm test -- src/agent/life-journal.test.ts
```

Expected: FAIL because runtime does not exist.

**Step 3: Implement runtime**

Add:

```ts
export interface LifeJournalRuntime {
  recordRound(input: {
    roundIndex: number;
    messages: AgentMessage[];
  }): Promise<{ ok: boolean; wroteJournal: boolean; updatedAgenda: boolean; error?: string }>;

  pickIdleIntention(): Promise<{ ok: boolean; intention: string | null; error?: string }>;
}

export function createLifeJournalRuntime(deps: {
  rootDir?: string;
  llm: LlmClient;
  now?: () => Date;
  maxRoundChars?: number;
}): LifeJournalRuntime;
```

Prompt rules for `recordRound`:

- Luna writes subjectively in first person.
- Output strict JSON with `shouldWrite`, `journalMarkdown`, `agendaMarkdown`.
- Use fixed journal headings: `Saw`, `Did`, `Promised`, `I care about`, `Next`, `Mood`.
- 0-3 bullets per section.
- Skip mechanical tool-call logs.
- Agenda must keep `Active`, `Waiting`, `Someday`, `Done`.

Implementation notes:

- Call `ensureLifeAgenda` before asking for agenda updates.
- Bound current round text by `maxRoundChars` defaulting to `6000`.
- Use no tools in the self-review LLM call.
- Record token usage with `recordTokenUsage({ operation: "life_journal.review", ... })` if practical.
- Fail closed: log and return `{ ok:false }`; never break BotLoop.

**Step 4: Run tests and verify pass**

Run:

```bash
pnpm test -- src/agent/life-journal.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/life-journal.ts src/agent/life-journal.test.ts
git commit -m "feat: add life journal self-review runtime"
```

### Task 3: BotLoop Post-Round Hook

**Files:**
- Modify: `src/agent/bot-loop-agent.ts`
- Modify: `src/agent/bot-loop-agent.test.ts`

**Step 1: Write failing tests**

Add a test proving the hook receives only messages appended during the round:

```ts
test("life journal hook receives bounded round delta after successful round", async () => {
  const received: AgentMessage[][] = [];
  const agent = createBotLoopAgent({
    // existing deps...
    lifeJournal: {
      recordRound: async ({ messages }) => {
        received.push(messages);
        return { ok: true, wroteJournal: true, updatedAgenda: false };
      },
      pickIdleIntention: async () => ({ ok: true, intention: null }),
    },
  });
  await agent.runOnceForTest();
  assert.equal(received.length, 1);
  assert.equal(received[0]!.some(message => message.role === "user"), true);
});
```

Also test:

- life journal failure does not throw and does not prevent compaction.
- life journal does not append anything to `AgentContext`.
- no hook call when `step()` consumes only wake events and runs no round.

**Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm test -- src/agent/bot-loop-agent.test.ts
```

Expected: FAIL because `lifeJournal` dep is unsupported.

**Step 3: Implement hook**

Add an optional dependency:

```ts
export interface BotLoopLifeJournal {
  recordRound(input: { roundIndex: number; messages: AgentMessage[] }): Promise<unknown>;
  pickIdleIntention?(): Promise<{ ok: boolean; intention: string | null }>;
}
```

In `step()`:

- capture `beforeRoundCount = deps.context.getSnapshot().messages.length` immediately before `runRound()`.
- after post-round snapshot save, compute `roundMessages = deps.context.getSnapshot().messages.slice(beforeRoundCount)`.
- call `deps.lifeJournal?.recordRound({ roundIndex, messages: roundMessages })` inside `try/catch`.
- run this before compaction so the current round is still available, but never append journal output to context.

**Step 4: Run tests and verify pass**

Run:

```bash
pnpm test -- src/agent/bot-loop-agent.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/bot-loop-agent.ts src/agent/bot-loop-agent.test.ts
git commit -m "feat: record life journal after agent rounds"
```

### Task 4: Idle Picker Hook

**Files:**
- Modify: `src/agent/bot-loop-agent.ts`
- Modify: `src/agent/bot-loop-agent.test.ts`
- Modify: `src/agent/render-event.ts`
- Modify: `src/agent/render-event.test.ts`
- Modify: `src/agent/event.ts`

**Step 1: Write failing tests**

Add an event type:

```ts
| {
    type: "life_idle_intention";
    intention: string;
  }
```

Test rendering:

```ts
assert.equal(
  renderBotEvent({ type: "life_idle_intention", intention: "继续整理 Life Journal" }),
  JSON.stringify({ event: "life_idle_intention", intention: "继续整理 Life Journal" }),
);
```

BotLoop tests:

- when no event is available, idle picker may enqueue one `life_idle_intention`.
- if picker returns `null`, BotLoop waits as before.
- repeated idle intentions are bounded by a small test-injected limit.
- attention events still interrupt idle waiting.

**Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm test -- src/agent/render-event.test.ts src/agent/bot-loop-agent.test.ts
```

Expected: FAIL because event/hook is missing.

**Step 3: Implement bounded idle picker**

Add `idleLife` options under existing `autonomy` or a separate optional dependency:

```ts
idleLife?: {
  enabled?: boolean;
  maxConsecutiveIdleIntentions?: number;
  minIntervalMs?: number;
}
```

In `runOnce()` when `!ranRound`:

- before `waitForExternalEvent()`, ask `deps.lifeJournal?.pickIdleIntention?.()`.
- if it returns a non-empty intention and guards allow it, enqueue `{ type: "life_idle_intention", intention }` and return so the next loop drains it.
- if no intention, continue to `waitForExternalEvent()`.
- reset idle counters when a real attention event arrives or the model calls `pause`.

Use conservative defaults:

- enabled by default only when `lifeJournal` is wired.
- `maxConsecutiveIdleIntentions = 1`.
- `minIntervalMs = 10 * 60 * 1000`.

**Step 4: Run tests and verify pass**

Run:

```bash
pnpm test -- src/agent/render-event.test.ts src/agent/bot-loop-agent.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/event.ts src/agent/render-event.ts src/agent/render-event.test.ts src/agent/bot-loop-agent.ts src/agent/bot-loop-agent.test.ts
git commit -m "feat: choose idle intentions from life agenda"
```

### Task 5: Wire Runtime And Prompt

**Files:**
- Modify: `src/index.ts`
- Modify: `prompts/bot-system.md`
- Modify: `src/agent/bot-system-prompt.test.ts`

**Step 1: Write failing tests**

Add prompt tests that lock these concepts:

- Life Journal is Luna's own notebook, not a mechanical log.
- Agenda is the first place to look for idle activity.
- Full journal content must not be dumped into the prompt.

**Step 2: Run prompt tests and verify failure**

Run:

```bash
pnpm test -- src/agent/bot-system-prompt.test.ts
```

Expected: FAIL until prompt is updated.

**Step 3: Wire `createLifeJournalRuntime`**

In `src/index.ts`:

```ts
import { createLifeJournalRuntime } from "./agent/life-journal.js";

const lifeJournal = createLifeJournalRuntime({
  rootDir: "data/agent-workspace",
  llm,
});

const agent = createBotLoopAgent({
  // existing deps
  lifeJournal,
});
```

Prompt guidance:

- Replace old broad journal guidance with Life Journal language.
- Keep `journal` tool wording only if the old tool remains visible.
- Do not add dynamic agenda or journal content to system prompt.

**Step 4: Run focused tests**

Run:

```bash
pnpm test -- src/agent/bot-system-prompt.test.ts src/agent/life-journal.test.ts src/agent/bot-loop-agent.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/index.ts prompts/bot-system.md src/agent/bot-system-prompt.test.ts
git commit -m "feat: wire life journal into bot runtime"
```

### Task 6: Verification And Docs

**Files:**
- Modify: `docs/AGENT_CONTEXT.md` if replay/life workspace boundaries need a note.
- Modify: `docs/ARCHITECTURE.md` if new runtime hook should be documented.
- Modify: `docs/TOOLS.md` only if the old `journal` tool behavior changes.

**Step 1: Run focused tests**

Run:

```bash
pnpm test -- src/agent/life-journal-store.test.ts src/agent/life-journal.test.ts src/agent/bot-loop-agent.test.ts src/agent/render-event.test.ts src/agent/bot-system-prompt.test.ts
```

Expected: PASS.

**Step 2: Run repo checks**

Run:

```bash
pnpm typecheck
pnpm repo-check
```

Expected: PASS.

**Step 3: Inspect diff**

Run:

```bash
git diff --stat
git diff -- src/agent/life-journal-store.ts src/agent/life-journal.ts src/agent/bot-loop-agent.ts src/agent/event.ts src/agent/render-event.ts src/index.ts prompts/bot-system.md
```

Expected:

- No generated `data/agent-workspace/life/**` files staged.
- No full journal content enters `AgentContext`.
- Life Journal errors are logged/skipped, not fatal.

**Step 4: Commit docs/check updates**

```bash
git add docs/AGENT_CONTEXT.md docs/ARCHITECTURE.md docs/TOOLS.md
git commit -m "docs: 记录 life journal 运行边界"
```

Skip this commit if no docs changed.

