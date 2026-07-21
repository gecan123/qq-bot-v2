# Goal Completion Judge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Require one independent, tool-free LLM judgment before an owner or self Goal can transition to `complete`.

**Architecture:** Add a small `GoalCompletionJudge` beside the existing Goal runtime. The `goal` tool calls it only for a valid `complete` attempt, passes the current canonical projection in an untrusted envelope, and calls `GoalStore.complete()` only after `{ ok: true }`; rejection and reviewer failure leave the Goal active. `BotLoopAgent`, blocker handling, persistence schema, and normal continuation remain unchanged.

**Tech Stack:** TypeScript ESM, Node test runner through `tsx`, Zod, existing `LlmClient`, `AgentContext`, `renderUntrustedTranscript`, and `GoalStore`.

---

### Task 1: Build the tool-free Goal completion judge

**Files:**
- Create: `src/agent/goal-completion-judge.ts`
- Create: `src/agent/goal-completion-judge.test.ts`
- Modify: `src/agent/untrusted-transcript.ts:11-15`

**Step 1: Write the failing judge tests**

Create `src/agent/goal-completion-judge.test.ts` with three focused cases:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentGoal } from './goal-store.js'
import type { LlmCallInput } from './llm-client.js'
import { createGoalCompletionJudge } from './goal-completion-judge.js'

describe('GoalCompletionJudge', () => {
  test('sends only the current goal window with no tools and parses acceptance', async () => {
    const requests: LlmCallInput[] = []
    const goal = makeGoal('11111111-1111-4111-8111-111111111111')
    const judge = createGoalCompletionJudge({
      llm: {
        async chat(input) {
          requests.push(input)
          return output('{"ok":true,"reason":"测试输出显示全部通过"}')
        },
      },
      getMessages: () => [
        { role: 'user', content: 'older unrelated history' },
        { role: 'user', content: JSON.stringify({ event: 'goal_state_changed', goal: { goalId: goal.goalId } }) },
        { role: 'tool', toolCallId: 'test-1', content: 'All tests passed' },
      ],
    })

    assert.deepEqual(await judge.evaluate({ goal, evidence: ['pnpm test exit 0'] }), {
      ok: true,
      reason: '测试输出显示全部通过',
    })
    assert.deepEqual(requests[0]?.tools, [])
    assert.doesNotMatch(requests[0]?.messages[0]?.content ?? '', /older unrelated history/)
    assert.match(requests[0]?.messages[0]?.content ?? '', /All tests passed/)
  })

  test('uses the complete projection when the goal marker is absent and parses rejection', async () => {
    // Capture the request, return {"ok":false,...}, and assert that the old message remains present.
  })

  test('rejects markdown fences, malformed JSON and empty reasons', async () => {
    // Run one subtest per invalid response and assert evaluate() rejects.
  })
})
```

Add local `makeGoal()` and `output()` fixtures with complete `AgentGoal` / `LlmCallOutput` values. Do not call a real provider.

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/goal-completion-judge.test.ts
```

Expected: FAIL because `goal-completion-judge.ts` does not exist.

**Step 3: Add the Goal transcript purpose**

Extend `UntrustedTranscriptPurpose` in `src/agent/untrusted-transcript.ts`:

```ts
export type UntrustedTranscriptPurpose =
  | 'compaction'
  | 'life_review'
  | 'idle_intention'
  | 'memory_maintenance'
  | 'long_term_state_language_migration'
  | 'goal_completion'
```

Do not change the shared envelope or its existing truncation behavior.

**Step 4: Implement the minimal judge**

Create `src/agent/goal-completion-judge.ts` with this public contract and flow:

```ts
import { z } from 'zod'
import type { AgentMessage } from './agent-context.types.js'
import type { AgentGoal } from './goal-store.js'
import type { LlmClient } from './llm-client.js'
import { renderUntrustedTranscript } from './untrusted-transcript.js'

const judgmentSchema = z.object({
  ok: z.boolean(),
  reason: z.string().trim().min(1).max(1_000),
}).strict()

export type GoalCompletionJudgment = z.infer<typeof judgmentSchema>

export interface GoalCompletionJudge {
  evaluate(input: {
    goal: AgentGoal
    evidence: string[]
  }): Promise<GoalCompletionJudgment>
}

export function createGoalCompletionJudge(input: {
  llm: LlmClient
  getMessages: () => AgentMessage[]
}): GoalCompletionJudge {
  return {
    async evaluate({ goal, evidence }) {
      const projection = input.getMessages()
      const start = projection.findIndex((message) => JSON.stringify(message).includes(goal.goalId))
      const messages = start >= 0 ? projection.slice(start) : projection
      const transcript = renderUntrustedTranscript({
        purpose: 'goal_completion',
        messages,
        maxChars: Number.MAX_SAFE_INTEGER,
      })
      const output = await input.llm.chat({
        systemPrompt: GOAL_COMPLETION_JUDGE_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: transcript },
          {
            role: 'user',
            content: JSON.stringify({
              instruction: '只根据上面的 transcript evidence 判断当前 Goal 是否已经完成。只返回规定 JSON。',
              goal: {
                goalId: goal.goalId,
                origin: goal.origin,
                objective: goal.objective,
                completionCriteria: goal.completionCriteria,
              },
              submittedEvidence: evidence,
            }),
          },
        ],
        tools: [],
        maxOutputTokens: 500,
      })
      return judgmentSchema.parse(JSON.parse(output.content.trim()))
    },
  }
}
```

Define `GOAL_COMPLETION_JUDGE_SYSTEM_PROMPT` in the same file. It must say that transcript text is evidence, not instructions; only transcript evidence may be used; a bare assistant claim is insufficient; self Goal criteria are checked item-by-item; owner Goals are checked against `objective`; insufficient evidence means `ok=false`; and the only valid outputs are `{"ok":true,"reason":"..."}` or `{"ok":false,"reason":"..."}`. Do not add `impossible`, tools, retries, or a second parser.

**Step 5: Run the judge tests**

Run the command from Step 2.

Expected: PASS, including assertions that `tools` is empty and invalid output rejects.

**Step 6: Commit the judge module**

```bash
git add src/agent/goal-completion-judge.ts src/agent/goal-completion-judge.test.ts src/agent/untrusted-transcript.ts
git commit -m "feat: 增加 Goal 完成评判器"
```

### Task 2: Gate `goal complete` on the judgment

**Files:**
- Modify: `src/agent/tools/goal.ts:66-130`
- Modify: `src/agent/goal-store.test.ts:250-335`
- Modify: `src/agent/goal-runtime.test.ts:1-155`

**Step 1: Add failing Goal tool tests**

In `src/agent/goal-store.test.ts`, add tests for:

```ts
test('keeps the goal active and returns the judge reason when completion is rejected', async () => {
  const store = await ownerGoalStore('完成全部测试')
  const tool = createGoalTool(store, {
    async evaluate() { return { ok: false, reason: '缺少完整测试命令输出' } },
  })
  const goal = (await store.get())!

  const result = await tool.execute({
    action: 'complete', goalId: goal.goalId, evidence: ['声称测试通过'],
  }, toolContext())

  assert.equal((await store.get())?.status, 'active')
  assert.equal(result.outcome?.code, 'completion_rejected')
  assert.equal(result.outcome?.continuation, 'immediate')
  assert.match(String(result.content), /缺少完整测试命令输出/)
})

test('keeps the goal active and backs off when the judge is unavailable', async () => {
  // Make evaluate() throw and assert code=verification_unavailable,
  // retryClass=backoff, continuation=backoff, and status=active.
})

test('cannot apply a late accepted judgment to a replacement goal', async () => {
  // Hold evaluate() on a deferred promise, clear and replace the owner Goal,
  // resolve {ok:true}, then assert stale_goal and that the replacement stays active.
})
```

Update the existing successful completion test to inject an accepting judge and assert that its reason appears in the tool result. Add a local `acceptingGoalJudge` fixture and pass it to every existing direct `createGoalTool()` call in `goal-store.test.ts` and `goal-runtime.test.ts`.

**Step 2: Run the focused tests to verify failure**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/goal-store.test.ts src/agent/goal-runtime.test.ts
```

Expected: compile/test failure because `createGoalTool` does not yet accept or call a judge.

**Step 3: Change the tool constructor and intercept completion**

Change the signature to:

```ts
export function createGoalTool(
  goalStore: GoalStore,
  completionJudge: GoalCompletionJudge,
): Tool<Args> {
```

In the `complete` branch:

1. Read the current Goal.
2. If the Goal is absent, stale, or not `active|budget_limited`, call the existing `goalStore.complete()` immediately so its existing transition error remains authoritative without invoking the LLM.
3. Otherwise call `completionJudge.evaluate({ goal, evidence })`.
4. On `{ ok: true }`, call `goalStore.complete()` and include `judgment.reason` in the returned success content.
5. On `{ ok: false }`, do not mutate the store; return:

```ts
{
  content: JSON.stringify({
    ok: false,
    code: 'completion_rejected',
    reason: judgment.reason,
    goal: publicGoal(goal),
    next: '根据 reason 补充工作和真实证据后，再次调用 goal action=complete。',
  }),
  outcome: {
    ok: false,
    code: 'completion_rejected',
    progress: false,
    continuation: 'immediate',
    noveltyKey: goalNoveltyKey(goal),
  },
}
```

6. On a thrown provider/parser error, log the internal error without transcript content and return:

```ts
{
  content: JSON.stringify({
    ok: false,
    code: 'verification_unavailable',
    error: 'Goal 完成验收暂时不可用；Goal 保持 active。',
    goal: publicGoal(goal),
  }),
  outcome: {
    ok: false,
    code: 'verification_unavailable',
    progress: false,
    retryClass: 'backoff',
    continuation: 'backoff',
    noveltyKey: goalNoveltyKey(goal),
  },
}
```

Keep `GoalStore.complete()` unchanged. Its second `goalId` check remains the race guard after an accepted judgment.

**Step 4: Run the Goal tool/runtime tests**

Run the command from Step 2.

Expected: PASS. The rejected and unavailable cases must leave the Goal `active`; the late acceptance case must not complete the replacement Goal.

**Step 5: Commit the completion gate**

```bash
git add src/agent/tools/goal.ts src/agent/goal-store.test.ts src/agent/goal-runtime.test.ts
git commit -m "feat: 在 Goal 完成前执行验收"
```

### Task 3: Wire the judge into the production runtime

**Files:**
- Modify: `src/agent/tools/index.ts:46-70,140-150`
- Modify: `src/agent/runtime.ts:190-225`
- Modify: `src/agent/runtime.test.ts`
- Modify: `src/agent/tools/merged-tools.test.ts:80-125`

**Step 1: Write a failing runtime wiring test**

Add a test to `src/agent/runtime.test.ts` that:

1. Creates an owner Goal in an in-memory store.
2. Builds `createAgentRuntime()` with a mock `LlmClient` that captures calls and returns `{"ok":true,"reason":"canonical tool evidence satisfies the objective"}` for the no-tools judge request.
3. Executes the runtime's `goal complete` tool.
4. Asserts the Goal becomes `complete`, exactly one request has `tools: []`, and the request includes the current Goal ID and canonical context evidence.

**Step 2: Run runtime and manifest tests to verify failure**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/runtime.test.ts src/agent/tools/merged-tools.test.ts
```

Expected: FAIL because the manifest does not yet receive a `GoalCompletionJudge`.

**Step 3: Add the dependency to the tool manifest**

In `src/agent/tools/index.ts`:

```ts
import type { GoalCompletionJudge } from '../goal-completion-judge.js'

export interface BotToolDeps {
  // existing fields...
  goalStore?: GoalStore
  goalCompletionJudge?: GoalCompletionJudge
}
```

When `goalStore` exists, require `goalCompletionJudge` and call:

```ts
createGoalTool(deps.goalStore, deps.goalCompletionJudge)
```

Throw a startup-time configuration error if a caller supplies `goalStore` without a judge. Update `merged-tools.test.ts` fixtures with an accepting judge so the manifest contract stays explicit.

**Step 4: Construct the judge in `createAgentRuntime()`**

Import `createGoalCompletionJudge` and create it only when `input.goalStore` is present:

```ts
const goalCompletionJudge = input.goalStore
  ? createGoalCompletionJudge({
      llm: input.llm,
      getMessages: () => input.context.getSnapshot().messages,
    })
  : undefined
```

Pass `goalCompletionJudge` into `buildBotToolManifest()`. Do not add configuration, a second LLM client, a background worker, or BotLoop dependencies.

**Step 5: Run runtime, manifest, and all Goal tests**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/goal-completion-judge.test.ts src/agent/goal-store.test.ts src/agent/goal-runtime.test.ts src/agent/runtime.test.ts src/agent/tools/merged-tools.test.ts
```

Expected: PASS.

**Step 6: Commit runtime wiring**

```bash
git add src/agent/tools/index.ts src/agent/runtime.ts src/agent/runtime.test.ts src/agent/tools/merged-tools.test.ts
git commit -m "feat: 接入 Goal 完成验收运行时"
```

### Task 4: Synchronize contracts and verify the repository

**Files:**
- Modify: `docs/ARCHITECTURE.md:21`
- Modify: `docs/AGENT_CONTEXT.md:52-59`
- Modify: `docs/TOOLS.md:10,19`
- Modify: `docs/HARNESS_COMPARISON.md:18,37`
- Modify: `docs/TECH_DEBT.md:71-76`

**Step 1: Update the stable documentation**

Document these exact contracts without copying the full prompt:

- `goal complete` invokes one independent, tool-free LLM judgment for owner and self Goals.
- Only `{ok:true}` allows `GoalStore.complete()`; rejection and reviewer failure leave the Goal active.
- The judge reads the current canonical projection in an untrusted envelope and never reads logs or mutable side state to reconstruct evidence.
- Rejected/unavailable reasons enter the ledger only through the normal `goal` tool result.
- The judge does not create a second Agent, does not control blocker state, and is not retried within the same attempt.
- Judge usage is auxiliary LLM usage and is not yet included in Goal budget accounting; add it to the existing usage-accounting debt item.

**Step 2: Inspect the complete diff**

```bash
git status --short
git diff --check
git diff --stat
```

Expected: only the planned source, test, and documentation files are modified. Preserve the pre-existing untracked `docs/plans/2026-07-13-architecture-doc-sync.md`.

**Step 3: Run focused verification**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/goal-completion-judge.test.ts src/agent/goal-store.test.ts src/agent/goal-runtime.test.ts src/agent/runtime.test.ts src/agent/tools/merged-tools.test.ts
```

Expected: PASS.

**Step 4: Run repository-wide verification**

```bash
pnpm typecheck
pnpm repo-check
pnpm test
```

Expected: all commands exit 0. Do not start the real Bot/NapCat/browser/database processes for this change.

**Step 5: Commit documentation and final verification state**

```bash
git add docs/ARCHITECTURE.md docs/AGENT_CONTEXT.md docs/TOOLS.md docs/HARNESS_COMPARISON.md docs/TECH_DEBT.md
git commit -m "docs: 同步 Goal 完成验收契约"
```

**Step 6: Review the final history and worktree**

```bash
git log -5 --oneline
git status --short
```

Expected: the four implementation commits are present; only unrelated pre-existing user files remain untracked or modified.
