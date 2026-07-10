# Lazy Group Mute Awareness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Luna 仅在群消息发送失败后按需确认自身是否被禁言，并通过稳定的 `send_message` tool result 感知该事实。

**Architecture:** 新增一个可注入、无缓存的 `GroupMuteInspector`，封装 NapCat `get_group_shut_list` 并把当前 SDK 的 `qid` / `shutUpTime` 规范化为 `{ muted, mutedUntil? }`。`send_message` 仅在群发送失败时调用它；确认失败降级为普通 `send_failed`，成功发送和私聊发送不产生额外查询。

**Tech Stack:** TypeScript 5.9、ESM、node-napcat-ts 0.4.21、Zod 4、Node.js test runner、pnpm。

---

### Task 1: 新增可测试的群禁言检查器

**Files:**
- Create: `src/messaging/group-mute-inspector.ts`
- Create: `src/messaging/group-mute-inspector.test.ts`

**Step 1: Write the failing tests**

创建 `src/messaging/group-mute-inspector.test.ts`，覆盖自身命中、未命中和非法时间：

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createGroupMuteInspector } from './group-mute-inspector.js'

describe('group mute inspector', () => {
  test('matches the bot qid and converts shutUpTime seconds to ISO', async () => {
    const inspector = createGroupMuteInspector({
      selfNumber: 123,
      async loadGroupShutList(groupId) {
        assert.equal(groupId, 456)
        return [
          { qid: '999', shutUpTime: 1_800_000_000 },
          { qid: '123', shutUpTime: 1_700_000_000 },
        ]
      },
    })

    assert.deepEqual(await inspector.inspect(456), {
      muted: true,
      mutedUntil: new Date(1_700_000_000 * 1000).toISOString(),
    })
  })

  test('returns muted=false when the bot is absent', async () => {
    const inspector = createGroupMuteInspector({
      selfNumber: 123,
      async loadGroupShutList() {
        return [{ qid: '999', shutUpTime: 1_700_000_000 }]
      },
    })

    assert.deepEqual(await inspector.inspect(456), { muted: false })
  })

  test('keeps confirmed mute but omits an invalid timestamp', async () => {
    const inspector = createGroupMuteInspector({
      selfNumber: 123,
      async loadGroupShutList() {
        return [{ qid: '123', shutUpTime: Number.NaN }]
      },
    })

    assert.deepEqual(await inspector.inspect(456), { muted: true })
  })
})
```

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/messaging/group-mute-inspector.test.ts
```

Expected: FAIL because `./group-mute-inspector.js` does not exist.

**Step 3: Write the minimal implementation**

创建 `src/messaging/group-mute-inspector.ts`：

```ts
import { napcat } from '../bot/napcat.js'
import { config } from '../config/index.js'

export interface GroupMuteInspection {
  muted: boolean
  mutedUntil?: string
}

export interface GroupMuteInspector {
  inspect(groupId: number): Promise<GroupMuteInspection>
}

interface GroupShutEntry {
  qid: string
  shutUpTime: number
}

interface GroupMuteInspectorDeps {
  selfNumber: number
  loadGroupShutList(groupId: number): Promise<readonly GroupShutEntry[]>
}

export function createGroupMuteInspector(deps: GroupMuteInspectorDeps): GroupMuteInspector {
  return {
    async inspect(groupId) {
      const entries = await deps.loadGroupShutList(groupId)
      const selfEntry = entries.find((entry) => entry.qid === String(deps.selfNumber))
      if (!selfEntry) return { muted: false }

      const mutedUntilDate = new Date(selfEntry.shutUpTime * 1000)
      const mutedUntil = Number.isFinite(mutedUntilDate.getTime())
        ? mutedUntilDate.toISOString()
        : undefined
      return {
        muted: true,
        ...(mutedUntil ? { mutedUntil } : {}),
      }
    },
  }
}

export const groupMuteInspector = createGroupMuteInspector({
  selfNumber: config.selfNumber,
  loadGroupShutList: async (groupId) => napcat.get_group_shut_list({ group_id: groupId }),
})
```

Do not add compatibility aliases for undocumented response fields; the installed SDK types are the codebase fact source.

**Step 4: Run the focused test to verify it passes**

Run the Step 2 command again.

Expected: 3 tests PASS.

**Step 5: Commit**

```bash
git add src/messaging/group-mute-inspector.ts src/messaging/group-mute-inspector.test.ts
git commit -m "feat: 新增群禁言状态检查器"
```

### Task 2: 在 `send_message` 群发送失败路径披露禁言事实

**Files:**
- Modify: `src/agent/tools/send-message.ts`
- Modify: `src/agent/tools/send-message.test.ts`

**Step 1: Add an injectable inspector fixture**

在 `src/agent/tools/send-message.test.ts` 导入 `GroupMuteInspector`，并增加：

```ts
import type { GroupMuteInspector, GroupMuteInspection } from '../../messaging/group-mute-inspector.js'

function makeMockMuteInspector(
  result: GroupMuteInspection = { muted: false },
  error?: Error,
): { inspector: GroupMuteInspector; calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    inspector: {
      async inspect(groupId) {
        calls.push(groupId)
        if (error) throw error
        return result
      },
    },
  }
}
```

调整测试 helper，使失败测试不会触碰真实 NapCat：

```ts
function createAllowedTool(
  sender: MessageSender,
  groupMuteInspector: GroupMuteInspector = makeMockMuteInspector().inspector,
) {
  return createSendMessageTool({ sender, targetPolicy: allowAllTargets, groupMuteInspector })
}
```

**Step 2: Write the failing tool tests**

在 group target 测试中增加四个断言场景，并在 private target 测试中增加一个场景：

```ts
test('confirms self mute after a failed group send', async () => {
  const { sender } = makeMockSender({ success: false, attempts: 2 })
  const mutedUntil = '2026-07-10T12:30:00.000Z'
  const { inspector, calls } = makeMockMuteInspector({ muted: true, mutedUntil })
  const tool = createAllowedTool(sender, inspector)

  const out = await tool.execute({
    target: { type: 'group', groupId: 111 },
    mode: 'reply',
    text: 'hi',
    replyToMessageId: 5,
  }, makeCtx())

  assert.deepEqual(calls, [111])
  assert.equal(parseToolResult(out.content).reason, 'group_muted')
  assert.equal(parseToolResult(out.content).mutedUntil, mutedUntil)
})

test('uses send_failed when group mute is not confirmed', async () => {
  const { sender } = makeMockSender({ success: false, attempts: 2 })
  const { inspector } = makeMockMuteInspector({ muted: false })
  const out = await createAllowedTool(sender, inspector).execute({
    target: { type: 'group', groupId: 111 },
    mode: 'ambient',
    text: 'hi',
    replyToMessageId: null,
  }, makeCtx())

  assert.equal(parseToolResult(out.content).reason, 'send_failed')
})

test('diagnostic failure degrades to send_failed', async () => {
  const { sender } = makeMockSender({ success: false, attempts: 2 })
  const { inspector } = makeMockMuteInspector({ muted: false }, new Error('query failed'))
  const out = await createAllowedTool(sender, inspector).execute({
    target: { type: 'group', groupId: 111 },
    mode: 'ambient',
    text: 'hi',
    replyToMessageId: null,
  }, makeCtx())

  assert.equal(parseToolResult(out.content).reason, 'send_failed')
})

test('does not inspect mute state after a successful group send', async () => {
  const { sender } = makeMockSender()
  const { inspector, calls } = makeMockMuteInspector()
  await createAllowedTool(sender, inspector).execute({
    target: { type: 'group', groupId: 111 },
    mode: 'ambient',
    text: 'hi',
    replyToMessageId: null,
  }, makeCtx())

  assert.deepEqual(calls, [])
})

test('does not inspect group mute state after a failed private send', async () => {
  const { sender } = makeMockSender({ success: false, attempts: 2 })
  const { inspector, calls } = makeMockMuteInspector()
  const out = await createAllowedTool(sender, inspector).execute({
    target: { type: 'private', userId: 10001 },
    mode: 'ambient',
    text: 'hi',
    replyToMessageId: null,
  }, makeCtx())

  assert.deepEqual(calls, [])
  assert.equal(parseToolResult(out.content).reason, 'send_failed')
})
```

Update the existing group failure test to assert `reason === 'send_failed'` while retaining its receipt assertions.

**Step 3: Run the focused test to verify it fails**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/tools/send-message.test.ts
```

Expected: the new assertions FAIL because `SendMessageDeps` has no inspector and failed receipts have no `reason`.

**Step 4: Implement the failed-send diagnosis**

在 `src/agent/tools/send-message.ts` 增加依赖和 receipt 字段：

```ts
import {
  groupMuteInspector as defaultGroupMuteInspector,
  type GroupMuteInspector,
} from '../../messaging/group-mute-inspector.js'

export interface SendMessageDeps {
  sender: MessageSender
  targetPolicy: SendTargetPolicy
  groupMuteInspector?: GroupMuteInspector
}

interface SendReceipt {
  // existing fields stay unchanged
  reason?: 'send_failed' | 'group_muted'
  mutedUntil?: string
}
```

增加有界诊断 helper：

```ts
async function diagnoseSendFailure(
  deps: SendMessageDeps,
  target: SendTarget,
): Promise<Pick<SendReceipt, 'reason' | 'mutedUntil'>> {
  if (target.type !== 'group') return { reason: 'send_failed' }
  try {
    const inspection = await (deps.groupMuteInspector ?? defaultGroupMuteInspector).inspect(target.groupId)
    if (!inspection.muted) return { reason: 'send_failed' }
    return {
      reason: 'group_muted',
      ...(inspection.mutedUntil ? { mutedUntil: inspection.mutedUntil } : {}),
    }
  } catch (error) {
    log.warn({ groupId: target.groupId, error }, 'send_message_group_mute_inspection_failed')
    return { reason: 'send_failed' }
  }
}
```

在 `sendResolved` 的 `!result.success` 分支中先调用 helper，再把字段合并到 receipt：

```ts
if (!result.success) {
  const diagnosis = await diagnoseSendFailure(deps, args.target)
  return {
    content: JSON.stringify({
      ...buildReceipt(
        args,
        'failed',
        result.attempts,
        null,
        'send failed (see SEND log)',
      ),
      ...diagnosis,
    }),
  }
}
```

Do not persist or cache `group_muted`, and do not reject a later send based on an earlier receipt.

**Step 5: Run focused tests to verify they pass**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/messaging/group-mute-inspector.test.ts src/agent/tools/send-message.test.ts
```

Expected: all tests PASS, with no NapCat connection attempt.

**Step 6: Commit**

```bash
git add src/agent/tools/send-message.ts src/agent/tools/send-message.test.ts
git commit -m "feat: 发送失败后确认群禁言"
```

### Task 3: 同步工具文档并做全量静态验证

**Files:**
- Modify: `docs/TOOLS.md`

**Step 1: Document the result contract**

在 `docs/TOOLS.md` 的发送安全规则附近增加：

```md
- 群 `send_message` 最终失败后才按需查询机器人自身的当前禁言状态；确认命中时 tool result 返回 `reason=group_muted` 和可用的 `mutedUntil`，否则返回 `reason=send_failed`。该事实不缓存，也不会阻止后续真实发送。
```

**Step 2: Run formatting and focused verification**

Run:

```bash
git diff --check
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/messaging/group-mute-inspector.test.ts src/agent/tools/send-message.test.ts
pnpm typecheck
pnpm repo-check
```

Expected: no diff errors; all focused tests PASS; typecheck and repo-check exit 0.

**Step 3: Review the bounded ledger output**

Inspect the diff and verify:

- No raw NapCat response or exception text is added to `ToolExecutionResult.content`.
- `reason` is always one of `send_failed` or `group_muted` for provider send failures.
- `mutedUntil` is present only when it is a valid ISO string.
- No BotEvent, database schema, mailbox cursor, snapshot schema, or system prompt bytes changed.

**Step 4: Commit**

```bash
git add docs/TOOLS.md
git commit -m "docs: 说明群禁言惰性感知"
```

### Task 4: Final verification

**Files:**
- No additional files unless verification exposes a defect.

**Step 1: Run the complete test suite**

Run:

```bash
pnpm test
```

Expected: all tests PASS without starting NapCat, QQ, browser, database, or a long-running process.

**Step 2: Run final repository checks**

Run:

```bash
pnpm typecheck
pnpm repo-check
git status --short
```

Expected: both checks exit 0; `git status --short` is empty.

**Step 3: Hand off**

Summarize the lazy behavior, the exact focused/full verification commands run, and any skipped live NapCat verification. Do not claim a real QQ mute was tested unless a separately authorized live test was actually performed.
