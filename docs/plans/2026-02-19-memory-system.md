# Memory System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a scheduled background job that progressively generates and updates group impressions and per-user profiles using the LLM, stored in PostgreSQL for manual inspection.

**Architecture:** A `setInterval`-based job runs every N hours and, for each monitored group, fetches messages since the last run cursor. Large batches are split into chunks by 20-minute time gaps (with 15-message overlap at boundaries) and summarized progressively — each chunk updates the running summary so topic context carries forward. Per-user profiles are generated separately from each user's own messages. A new `generateText` method on `LlmProvider` powers structured generation separately from the chat reply path. No context injection in this phase.

**Tech Stack:** Prisma 7, PostgreSQL, pino, Node.js `setInterval`, existing `GeminiProvider`

---

### Task 1: Add GroupMemory and UserMemory to Prisma schema

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: Append models to schema**

Add to `prisma/schema.prisma`:

```prisma
model GroupMemory {
  id            Int      @id @default(autoincrement())
  groupId       BigInt   @unique @map("group_id")
  groupName     String?  @map("group_name") @db.VarChar(255)
  summary       String   @map("summary") @db.Text
  lastMessageId BigInt   @map("last_message_id")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@map("group_memory")
}

model UserMemory {
  id                  Int      @id @default(autoincrement())
  groupId             BigInt   @map("group_id")
  groupName           String?  @map("group_name") @db.VarChar(255)
  senderId            BigInt   @map("sender_id")
  senderNickname      String?  @map("sender_nickname") @db.VarChar(100)
  senderGroupNickname String?  @map("sender_group_nickname") @db.VarChar(100)
  profile             String   @map("profile") @db.Text
  examples            String[] @map("examples")
  updatedAt           DateTime @updatedAt @map("updated_at")

  @@unique([groupId, senderId])
  @@map("user_memory")
}
```

**Step 2: Create and apply migration**

```bash
pnpm db:migrate
```

When prompted for migration name, enter: `add_memory_tables`

Expected: Migration applied successfully.

**Step 3: Regenerate Prisma client**

```bash
pnpm db:generate
```

Expected: Client generated to `src/generated/prisma/`.

**Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add GroupMemory and UserMemory schema"
```

---

### Task 2: Add memory job config vars

**Files:**
- Modify: `src/config/index.ts`

**Step 1: Add two optional config vars**

Add to the `config` object (after `replyMediaTimeoutMs`):

```ts
memoryJobIntervalHours: Number(process.env.MEMORY_JOB_INTERVAL_HOURS ?? '4'),
memoryJobSkipThreshold: Number(process.env.MEMORY_JOB_SKIP_THRESHOLD ?? '20'),
```

**Step 2: Add to `.env.example` if the file exists**

```
MEMORY_JOB_INTERVAL_HOURS=4
MEMORY_JOB_SKIP_THRESHOLD=20
```

**Step 3: Commit**

```bash
git add src/config/index.ts .env.example
git commit -m "feat: add memory job config vars"
```

---

### Task 3: Add generateText to LlmProvider

**Files:**
- Modify: `src/llm/types.ts`
- Modify: `src/llm/gemini-adapter.ts`

**Step 1: Add optional method to interface**

In `src/llm/types.ts`, add `generateText?`:

```ts
export interface LlmProvider {
  describeImage(params: { image: Buffer; contentType: string; mediaType?: string }): Promise<string>
  summarizeText(params: { text: string; context?: string }): Promise<string>
  transcribeAudio?(params: { audio: Buffer; contentType: string }): Promise<string>
  generateReply?(systemPrompt: string, context: string, trigger: string): Promise<string>
  generateText?(systemInstruction: string, prompt: string): Promise<string>
}
```

**Step 2: Implement in GeminiProvider**

Add method inside the `GeminiProvider` class (after `summarizeText`):

```ts
async generateText(systemInstruction: string, prompt: string): Promise<string> {
    const response = await this.server.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { systemInstruction, temperature: 0.4 },
    })
    return this.extractText(response).trim()
}
```

**Step 3: Commit**

```bash
git add src/llm/types.ts src/llm/gemini-adapter.ts
git commit -m "feat: add generateText method to LlmProvider"
```

---

### Task 4: DB access layer for memory

**Files:**
- Create: `src/database/memory.ts`

**Step 1: Write the module**

```ts
import { prisma } from './client.js'
import type { GroupMemory, UserMemory } from '../generated/prisma/client.js'

export type { GroupMemory, UserMemory }

export async function getGroupMemory(groupId: bigint): Promise<GroupMemory | null> {
  return prisma.groupMemory.findUnique({ where: { groupId } })
}

export interface UpsertGroupMemoryParams {
  groupId: bigint
  groupName: string | null
  summary: string
  lastMessageId: bigint
}

export async function upsertGroupMemory(params: UpsertGroupMemoryParams): Promise<void> {
  await prisma.groupMemory.upsert({
    where: { groupId: params.groupId },
    create: params,
    update: {
      groupName: params.groupName,
      summary: params.summary,
      lastMessageId: params.lastMessageId,
    },
  })
}

export async function getUserMemory(groupId: bigint, senderId: bigint): Promise<UserMemory | null> {
  return prisma.userMemory.findUnique({
    where: { groupId_senderId: { groupId, senderId } },
  })
}

export interface UpsertUserMemoryParams {
  groupId: bigint
  groupName: string | null
  senderId: bigint
  senderNickname: string | null
  senderGroupNickname: string | null
  profile: string
  examples: string[]
}

export async function upsertUserMemory(params: UpsertUserMemoryParams): Promise<void> {
  await prisma.userMemory.upsert({
    where: { groupId_senderId: { groupId: params.groupId, senderId: params.senderId } },
    create: params,
    update: {
      groupName: params.groupName,
      senderNickname: params.senderNickname,
      senderGroupNickname: params.senderGroupNickname,
      profile: params.profile,
      examples: params.examples,
    },
  })
}
```

**Step 2: Commit**

```bash
git add src/database/memory.ts
git commit -m "feat: add memory DB access layer"
```

---

### Task 5: Prompt builders

**Files:**
- Create: `src/memory/prompts.ts`
- Create: `src/memory/prompts.test.ts`

**Step 1: Write the failing tests**

`src/memory/prompts.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildGroupSummaryPrompt, buildUserProfilePrompt } from './prompts.js'

describe('buildGroupSummaryPrompt', () => {
  test('includes old summary when present', () => {
    const prompt = buildGroupSummaryPrompt('旧摘要内容', '消息内容')
    assert.ok(prompt.includes('旧摘要内容'))
    assert.ok(prompt.includes('消息内容'))
  })

  test('handles null old summary gracefully', () => {
    const prompt = buildGroupSummaryPrompt(null, '消息内容')
    assert.ok(prompt.includes('消息内容'))
    assert.ok(!prompt.includes('null'))
  })
})

describe('buildUserProfilePrompt', () => {
  test('includes old profile and examples when present', () => {
    const prompt = buildUserProfilePrompt('旧画像', ['例句1', '例句2'], '用户消息')
    assert.ok(prompt.includes('旧画像'))
    assert.ok(prompt.includes('例句1'))
    assert.ok(prompt.includes('用户消息'))
  })

  test('handles null old profile gracefully', () => {
    const prompt = buildUserProfilePrompt(null, [], '用户消息')
    assert.ok(prompt.includes('用户消息'))
    assert.ok(!prompt.includes('null'))
  })

  test('requests JSON output', () => {
    const prompt = buildUserProfilePrompt(null, [], '消息')
    assert.ok(prompt.toLowerCase().includes('json'))
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
pnpm test src/memory/prompts.test.ts
```

Expected: FAIL - module not found.

**Step 3: Implement prompts.ts**

`src/memory/prompts.ts`:

```ts
export function buildGroupSummaryPrompt(oldSummary: string | null, formattedMessages: string): string {
  const oldSummarySection = oldSummary
    ? `你之前对这个群的了解：\n${oldSummary}\n\n`
    : ''

  return `${oldSummarySection}以下是该群最近的新消息：
${formattedMessages}

请更新你对这个群的整体印象，包括：群的氛围风格、常见话题、成员活跃规律。
保留旧印象中仍然成立的部分，补充新观察，修正已过时的描述。
用中文简洁描述，200字以内。`
}

export function buildUserProfilePrompt(
  oldProfile: string | null,
  oldExamples: string[],
  formattedMessages: string,
): string {
  const oldProfileSection =
    oldProfile
      ? `你之前对此人的了解：\n${oldProfile}\n\n旧的代表性发言：\n${oldExamples.map((e) => `- ${e}`).join('\n')}\n\n`
      : ''

  return `${oldProfileSection}此人最近的发言：
${formattedMessages}

请更新你对此人的印象（性格、兴趣、说话风格），并从上面的发言中挑选3-5句最能代表其说话方式的原话作为例句。
用中文描述，印象部分100字以内。

请严格返回如下 JSON 格式，不要添加任何其他内容：
{"profile": "...", "examples": ["...", "...", "..."]}`
}
```

**Step 4: Run tests**

```bash
pnpm test src/memory/prompts.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/prompts.ts src/memory/prompts.test.ts
git commit -m "feat: add memory prompt builders"
```

---

### Task 6: Message formatter for memory

**Files:**
- Create: `src/memory/format-messages.ts`
- Create: `src/memory/format-messages.test.ts`

**Step 1: Write failing tests**

`src/memory/format-messages.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatMessagesForMemory } from './format-messages.js'
import type { Message } from '../generated/prisma/client.js'

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    groupId: 100n,
    groupName: '测试群',
    mediaReferenceIds: [],
    messageId: 1n,
    senderId: 1n,
    senderNickname: '小明',
    senderGroupNickname: null,
    content: [{ type: 'text', content: '你好' }] as unknown as Message['content'],
    rawContent: null,
    rawMessage: null,
    createdAt: new Date('2026-01-01T10:30:00'),
    ...overrides,
  }
}

describe('formatMessagesForMemory', () => {
  test('formats a text message with time and nickname', () => {
    const result = formatMessagesForMemory([makeMsg()])
    assert.ok(result.includes('小明'))
    assert.ok(result.includes('你好'))
    assert.ok(result.includes('10:30'))
  })

  test('prefers senderGroupNickname over senderNickname', () => {
    const result = formatMessagesForMemory([makeMsg({ senderGroupNickname: '群昵称' })])
    assert.ok(result.includes('群昵称'))
    assert.ok(!result.includes('小明'))
  })

  test('skips messages with no renderable text', () => {
    const result = formatMessagesForMemory([
      makeMsg({ content: [{ type: 'face', faceId: 1 }] as unknown as Message['content'] }),
    ])
    assert.equal(result.trim(), '')
  })

  test('returns empty string for empty array', () => {
    assert.equal(formatMessagesForMemory([]), '')
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
pnpm test src/memory/format-messages.test.ts
```

Expected: FAIL

**Step 3: Implement format-messages.ts**

`src/memory/format-messages.ts`:

```ts
import type { Message } from '../generated/prisma/client.js'
import type { ParsedSegment } from '../types/message-segments.js'

function segmentsToText(segments: ParsedSegment[]): string {
  return segments
    .map((seg) => {
      switch (seg.type) {
        case 'text': return seg.content
        case 'image': return seg.summary ? `[图片: ${seg.summary}]` : '[图片]'
        case 'video': return seg.description ? `[视频: ${seg.description}]` : '[视频]'
        case 'record': return seg.description ? `[语音: ${seg.description}]` : '[语音]'
        case 'file': return seg.fileName ? `[文件: ${seg.fileName}]` : '[文件]'
        case 'face': return seg.name ? `[表情: ${seg.name}]` : '[表情]'
        case 'at': return seg.targetName ? `@${seg.targetName}` : `@${seg.targetId}`
        default: return ''
      }
    })
    .join('')
    .trim()
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function formatMessagesForMemory(messages: Message[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    const segments = msg.content as unknown as ParsedSegment[]
    const text = segmentsToText(segments)
    if (!text) continue
    const nickname = msg.senderGroupNickname ?? msg.senderNickname
    const time = formatTime(msg.createdAt)
    lines.push(`[${time}] ${nickname}: ${text}`)
  }
  return lines.join('\n')
}
```

**Step 4: Run tests**

```bash
pnpm test src/memory/format-messages.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/format-messages.ts src/memory/format-messages.test.ts
git commit -m "feat: add message formatter for memory job"
```

---

### Task 6b: Message chunker

**Files:**
- Create: `src/memory/chunk-messages.ts`
- Create: `src/memory/chunk-messages.test.ts`

**Step 1: Write failing tests**

`src/memory/chunk-messages.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { chunkByTimeGap, addOverlap } from './chunk-messages.js'

function makeMsg(minutesFromStart: number, id = 1) {
  return {
    messageId: BigInt(id),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, minutesFromStart, 0)),
  }
}

describe('chunkByTimeGap', () => {
  test('keeps all messages in one chunk when no large gap', () => {
    const msgs = [makeMsg(0, 1), makeMsg(5, 2), makeMsg(10, 3)]
    const chunks = chunkByTimeGap(msgs as never, 20)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].length, 3)
  })

  test('splits on gap exceeding threshold', () => {
    const msgs = [makeMsg(0, 1), makeMsg(5, 2), makeMsg(30, 3), makeMsg(35, 4)]
    const chunks = chunkByTimeGap(msgs as never, 20)
    assert.equal(chunks.length, 2)
    assert.equal(chunks[0].length, 2)
    assert.equal(chunks[1].length, 2)
  })

  test('returns empty array for empty input', () => {
    assert.deepEqual(chunkByTimeGap([], 20), [])
  })
})

describe('addOverlap', () => {
  test('first chunk is unchanged', () => {
    const chunks = [[makeMsg(0, 1), makeMsg(1, 2)], [makeMsg(30, 3)]] as never
    const result = addOverlap(chunks, 2)
    assert.equal(result[0].length, 2)
  })

  test('subsequent chunks prepend tail of previous chunk', () => {
    const a = [makeMsg(0, 1), makeMsg(1, 2), makeMsg(2, 3)]
    const b = [makeMsg(30, 4)]
    const result = addOverlap([a, b] as never, 2)
    assert.equal(result[1].length, 3) // 2 overlap + 1 original
    assert.equal(result[1][0].messageId, 2n)
    assert.equal(result[1][2].messageId, 4n)
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
pnpm test src/memory/chunk-messages.test.ts
```

Expected: FAIL

**Step 3: Implement chunk-messages.ts**

`src/memory/chunk-messages.ts`:

```ts
import type { Message } from '../generated/prisma/client.js'

export function chunkByTimeGap(messages: Message[], gapMinutes: number): Message[][] {
  if (messages.length === 0) return []
  const gapMs = gapMinutes * 60 * 1000
  const chunks: Message[][] = []
  let current: Message[] = [messages[0]]
  for (let i = 1; i < messages.length; i++) {
    const gap = messages[i].createdAt.getTime() - messages[i - 1].createdAt.getTime()
    if (gap > gapMs) {
      chunks.push(current)
      current = []
    }
    current.push(messages[i])
  }
  chunks.push(current)
  return chunks
}

export function addOverlap(chunks: Message[][], overlapSize: number): Message[][] {
  return chunks.map((chunk, i) => {
    if (i === 0) return chunk
    const overlap = chunks[i - 1].slice(-overlapSize)
    return [...overlap, ...chunk]
  })
}
```

**Step 4: Run tests**

```bash
pnpm test src/memory/chunk-messages.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/chunk-messages.ts src/memory/chunk-messages.test.ts
git commit -m "feat: add time-gap message chunker with overlap"
```

---

### Task 7: Refresh memory job

**Files:**
- Create: `src/jobs/refresh-memory.ts`

**Step 1: Write the job**

`src/jobs/refresh-memory.ts`:

```ts
import { prisma } from '../database/client.js'
import { getLlmProvider } from '../llm/provider.js'
import { log } from '../logger.js'
import { config } from '../config/index.js'
import { getGroupMemory, upsertGroupMemory, getUserMemory, upsertUserMemory } from '../database/memory.js'
import { formatMessagesForMemory } from '../memory/format-messages.js'
import { buildGroupSummaryPrompt, buildUserProfilePrompt } from '../memory/prompts.js'
import { chunkByTimeGap, addOverlap } from '../memory/chunk-messages.js'
import type { Message } from '../generated/prisma/client.js'

const MEMORY_SYSTEM_INSTRUCTION =
  '你是一个群聊分析助手，负责为机器人维护对群聊和群成员的长期印象记忆。请根据提供的消息客观、简洁地更新印象描述。'

const GAP_MINUTES = 20
const OVERLAP_SIZE = 15

function parseUserProfileJson(raw: string): { profile: string; examples: string[] } | null {
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  try {
    const parsed = JSON.parse(cleaned) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).profile === 'string' &&
      Array.isArray((parsed as Record<string, unknown>).examples)
    ) {
      return parsed as { profile: string; examples: string[] }
    }
  } catch {
    // fall through
  }
  return null
}

async function refreshGroup(groupId: number): Promise<void> {
  const provider = getLlmProvider()
  if (!provider?.generateText) {
    log.debug('LLM provider 不支持 generateText，跳过记忆更新')
    return
  }

  const groupBigInt = BigInt(groupId)
  const existing = await getGroupMemory(groupBigInt)
  const lastMessageId = existing?.lastMessageId ?? 0n

  const newMessages = await prisma.message.findMany({
    where: { groupId: groupBigInt, messageId: { gt: lastMessageId } },
    orderBy: { messageId: 'asc' },
  })

  if (newMessages.length < config.memoryJobSkipThreshold) {
    log.debug({ groupId, newCount: newMessages.length }, '新消息不足，跳过本群记忆更新')
    return
  }

  log.info({ groupId, newCount: newMessages.length }, '开始更新群记忆')

  const groupName = newMessages[newMessages.length - 1]?.groupName ?? null
  const maxMessageId = newMessages.reduce((max, m) => (m.messageId > max ? m.messageId : max), 0n)

  // Update group summary: chunk by time gap, add overlap, roll forward progressively
  const chunks = addOverlap(chunkByTimeGap(newMessages, GAP_MINUTES), OVERLAP_SIZE)
  let runningSummary = existing?.summary ?? null
  for (const chunk of chunks) {
    const formatted = formatMessagesForMemory(chunk)
    if (!formatted.trim()) continue
    const prompt = buildGroupSummaryPrompt(runningSummary, formatted)
    runningSummary = await provider.generateText(MEMORY_SYSTEM_INSTRUCTION, prompt)
    log.debug({ groupId, chunkSize: chunk.length }, '已处理一个消息分段')
  }

  if (runningSummary && runningSummary !== (existing?.summary ?? null)) {
    await upsertGroupMemory({ groupId: groupBigInt, groupName, summary: runningSummary, lastMessageId: maxMessageId })
    log.info({ groupId, chunks: chunks.length }, '群摘要已更新')
  }

  // Update per-user profiles (volume per user is small, no chunking needed)
  const byUser = new Map<bigint, Message[]>()
  for (const msg of newMessages) {
    const arr = byUser.get(msg.senderId) ?? []
    arr.push(msg)
    byUser.set(msg.senderId, arr)
  }

  for (const [senderId, userMsgs] of byUser) {
    const formattedUser = formatMessagesForMemory(userMsgs)
    if (!formattedUser.trim()) continue

    const existingUser = await getUserMemory(groupBigInt, senderId)
    const userPrompt = buildUserProfilePrompt(
      existingUser?.profile ?? null,
      existingUser?.examples ?? [],
      formattedUser,
    )
    const raw = await provider.generateText(MEMORY_SYSTEM_INSTRUCTION, userPrompt)
    const parsed = parseUserProfileJson(raw)

    if (!parsed) {
      log.warn({ groupId, senderId: senderId.toString() }, 'LLM 返回的用户画像 JSON 解析失败，跳过')
      continue
    }

    const lastMsg = userMsgs[userMsgs.length - 1]
    await upsertUserMemory({
      groupId: groupBigInt,
      groupName,
      senderId,
      senderNickname: lastMsg.senderNickname,
      senderGroupNickname: lastMsg.senderGroupNickname,
      profile: parsed.profile,
      examples: parsed.examples,
    })
    log.info({ groupId, senderId: senderId.toString() }, '用户画像已更新')
  }
}

async function runMemoryRefresh(): Promise<void> {
  log.info('开始记忆刷新 job')
  for (const groupId of config.groupIds) {
    try {
      await refreshGroup(groupId)
    } catch (err) {
      log.error({ err, groupId }, '群记忆更新失败')
    }
  }
  log.info('记忆刷新 job 完成')
}

export function startMemoryRefreshJob(): () => void {
  const intervalMs = config.memoryJobIntervalHours * 60 * 60 * 1000

  // Run once 30s after startup, then on fixed interval
  const startupTimer = setTimeout(() => {
    runMemoryRefresh().catch((err) => log.error({ err }, '初始记忆刷新失败'))
  }, 30_000)

  const intervalHandle = setInterval(() => {
    runMemoryRefresh().catch((err) => log.error({ err }, '定时记忆刷新失败'))
  }, intervalMs)

  return () => {
    clearTimeout(startupTimer)
    clearInterval(intervalHandle)
  }
}
```

**Step 2: Commit**

```bash
git add src/jobs/refresh-memory.ts
git commit -m "feat: add refresh-memory background job"
```

---

### Task 8: Wire job into index.ts

**Files:**
- Modify: `src/index.ts`

**Step 1: Add import**

```ts
import { startMemoryRefreshJob } from './jobs/refresh-memory.js'
```

**Step 2: Start job in main()**

After `jobQueue.start()`, add:

```ts
const stopMemoryJob = startMemoryRefreshJob()
log.info('Memory refresh job started')
```

**Step 3: Stop job in shutdown()**

Before `jobQueue.stop()`, add:

```ts
stopMemoryJob()
```

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire memory refresh job into startup"
```

---

### Verification

Start the bot and watch logs:

```bash
pnpm dev
```

After ~30 seconds, expect to see:
```
开始记忆刷新 job
开始更新群记忆  (or: 新消息不足，跳过本群记忆更新)
记忆刷新 job 完成
```

Then inspect the results:

```sql
SELECT group_name, LEFT(summary, 200), updated_at FROM group_memory;
SELECT group_name, sender_group_nickname, LEFT(profile, 150), examples, updated_at FROM user_memory;
```
