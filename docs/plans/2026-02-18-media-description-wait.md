# Media Description Wait Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 回复前等待最近 N 条消息的媒体描述生成完毕，超时后降级为占位符，队列和 on-demand 路径通过 in-flight Map 去重，避免重复 LLM 调用。

**Architecture:** 提取 `withInFlight` 纯工具函数做进程内去重；`generate-description.ts` 暴露 `generateDescriptionForMedia(mediaId)` 供外部调用；新增 `ensure-descriptions.ts` 在回复前并行等待未就绪的媒体；`buildContext()` 在 `resolveMessage` 之前调用它。

**Tech Stack:** Node.js built-in test runner (`node:test` + `node:assert/strict`)，Prisma 7，pino 日志。

---

### Task 1: Add config variables with Chinese comments

**Files:**
- Modify: `src/config/index.ts`
- Modify: `.env.example`

**Step 1: 加两个可选配置项到 `src/config/index.ts`**

在 `config` 对象末尾追加（`as const` 之前）：

```ts
export const config = {
  databaseUrl: requireEnv('DATABASE_URL'),
  redisUrl: requireEnv('REDIS_URL'),
  napcat: {
    wsUrl: requireEnv('NAPCAT_WS_URL'),
    accessToken: requireEnv('NAPCAT_ACCESS_TOKEN'),
  },
  groupIds: requireEnv('GROUP_IDS').split(',').map(Number),
  selfNumber: Number(requireEnv('SELF_NUMBER')),
  nodeEnv: process.env.NODE_ENV || 'development',
  replyMediaWaitN: Number(process.env.REPLY_MEDIA_WAIT_N ?? '5'),
  replyMediaTimeoutMs: Number(process.env.REPLY_MEDIA_TIMEOUT_MS ?? '5000'),
} as const
```

**Step 2: 更新 `.env.example`，在文件末尾追加**

```
# 回复时等待媒体描述生成的最近 N 条消息数量（默认 5）
# REPLY_MEDIA_WAIT_N=5

# 等待媒体描述生成的最长超时（单位毫秒），超时后降级为 [图片] 占位符（默认 5000）
# REPLY_MEDIA_TIMEOUT_MS=5000
```

注意：两行都用 `#` 注释掉，表示可选。

**Step 3: Verify TypeScript compiles**

```bash
pnpm build
```

Expected: 无报错。

**Step 4: Commit**

```bash
git add src/config/index.ts .env.example
git commit -m "feat: add REPLY_MEDIA_WAIT_N and REPLY_MEDIA_TIMEOUT_MS config"
```

---

### Task 2: Create `withInFlight` utility with tests

**Files:**
- Create: `src/utils/in-flight.ts`
- Create: `src/utils/in-flight.test.ts`

**Step 1: Write the failing tests**

Create `src/utils/in-flight.test.ts`：

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { withInFlight } from './in-flight.js'

describe('withInFlight', () => {
  test('calls fn once when two concurrent calls share the same key', async () => {
    const cache = new Map<number, Promise<void>>()
    let callCount = 0
    const slow = () =>
      new Promise<void>((resolve) => {
        callCount++
        setTimeout(resolve, 10)
      })

    await Promise.all([withInFlight(cache, 1, slow), withInFlight(cache, 1, slow)])

    assert.equal(callCount, 1)
  })

  test('calls fn again after the first call completes', async () => {
    const cache = new Map<number, Promise<void>>()
    let callCount = 0
    const fn = () =>
      new Promise<void>((resolve) => {
        callCount++
        resolve()
      })

    await withInFlight(cache, 1, fn)
    await withInFlight(cache, 1, fn)

    assert.equal(callCount, 2)
  })

  test('different keys run independently', async () => {
    const cache = new Map<number, Promise<void>>()
    let callCount = 0
    const slow = () =>
      new Promise<void>((resolve) => {
        callCount++
        setTimeout(resolve, 10)
      })

    await Promise.all([withInFlight(cache, 1, slow), withInFlight(cache, 2, slow)])

    assert.equal(callCount, 2)
  })

  test('clears key from cache after fn completes', async () => {
    const cache = new Map<number, Promise<void>>()
    const fn = () => Promise.resolve()

    await withInFlight(cache, 1, fn)

    assert.equal(cache.size, 0)
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
node --import tsx/esm --test src/utils/in-flight.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` 或 import 错误（文件不存在）。

**Step 3: Implement `src/utils/in-flight.ts`**

```ts
export function withInFlight<K>(
  cache: Map<K, Promise<void>>,
  key: K,
  fn: () => Promise<void>,
): Promise<void> {
  if (cache.has(key)) return cache.get(key)!
  const p = fn().finally(() => cache.delete(key))
  cache.set(key, p)
  return p
}
```

**Step 4: Run tests to verify they pass**

```bash
node --import tsx/esm --test src/utils/in-flight.test.ts
```

Expected: 4 tests PASS。

**Step 5: Commit**

```bash
git add src/utils/in-flight.ts src/utils/in-flight.test.ts
git commit -m "feat: add withInFlight dedup utility"
```

---

### Task 3: Refactor `generate-description.ts` to expose `generateDescriptionForMedia`

**Files:**
- Modify: `src/jobs/generate-description.ts`

这个任务是纯重构：把现有 `handleGenerateDescription` 里的逻辑拆成 `doGenerate`（内部函数）和 `generateDescriptionForMedia`（导出函数），加 in-flight Map。外部行为不变。

**Step 1: 重写 `src/jobs/generate-description.ts`**

```ts
import { prisma } from '../database/client.js'
import { getLlmProvider } from '../llm/provider.js'
import { log } from '../logger.js'
import { withInFlight } from '../utils/in-flight.js'
import type { Job } from '../queue/types.js'

export interface GenerateDescriptionData {
  mediaId: number
}

const VISION_MEDIA_TYPES = new Set(['image', 'sticker', 'video'])

const inFlight = new Map<number, Promise<void>>()

export function generateDescriptionForMedia(mediaId: number): Promise<void> {
  return withInFlight(inFlight, mediaId, () => doGenerate(mediaId))
}

async function doGenerate(mediaId: number): Promise<void> {
  const media = await prisma.media.findUnique({
    where: { mediaId },
    select: { data: true, contentType: true, mediaType: true, description: true },
  })

  if (!media) {
    log.warn({ mediaId }, '媒体记录不存在，跳过描述生成')
    return
  }

  if (media.description) {
    log.debug({ mediaId }, '描述已存在，跳过')
    return
  }

  const provider = getLlmProvider()
  if (!provider) {
    log.debug({ mediaId }, 'LLM provider 未配置，跳过描述生成')
    return
  }

  const mediaType = media.mediaType ?? 'unknown'

  if (VISION_MEDIA_TYPES.has(mediaType)) {
    const buffer = Buffer.from(media.data)
    if (buffer.length === 0) {
      log.debug({ mediaId }, '媒体数据为空，跳过描述生成')
      return
    }

    const description = await provider.describeImage({
      image: buffer,
      contentType: media.contentType ?? 'application/octet-stream',
      mediaType,
    })

    await prisma.media.update({ where: { mediaId }, data: { description } })
    log.info({ mediaId }, '媒体描述已生成')
    return
  }

  if (mediaType === 'record') {
    if (!provider.transcribeAudio) {
      log.debug({ mediaId }, 'LLM provider 不支持语音转写，跳过')
      return
    }

    const buffer = Buffer.from(media.data)
    if (buffer.length === 0) {
      log.debug({ mediaId }, '语音数据为空，跳过')
      return
    }

    const description = await provider.transcribeAudio({
      audio: buffer,
      contentType: media.contentType ?? 'audio/mp4',
    })

    await prisma.media.update({ where: { mediaId }, data: { description } })
    log.info({ mediaId }, '语音转写已完成')
    return
  }

  if (mediaType === 'file') {
    log.debug({ mediaId }, '文件文本提取暂未实现，跳过')
    return
  }

  log.debug({ mediaId, mediaType }, '不支持的媒体类型，跳过描述生成')
}

export async function handleGenerateDescription(
  job: Job<'generate-description', GenerateDescriptionData>,
): Promise<void> {
  return generateDescriptionForMedia(job.data.mediaId)
}
```

注意：`jobId` 从 log 里移除了（`doGenerate` 不知道 job）。若需要保留，可在 `handleGenerateDescription` 里单独记一条 log。检查原始代码里 jobId 的 log 是否关键——如果需要，在 `handleGenerateDescription` 加：

```ts
export async function handleGenerateDescription(
  job: Job<'generate-description', GenerateDescriptionData>,
): Promise<void> {
  log.debug({ jobId: job.id, mediaId: job.data.mediaId }, '队列任务开始处理媒体描述')
  return generateDescriptionForMedia(job.data.mediaId)
}
```

**Step 2: Verify TypeScript compiles**

```bash
pnpm build
```

Expected: 无报错。

**Step 3: Commit**

```bash
git add src/jobs/generate-description.ts
git commit -m "refactor: extract generateDescriptionForMedia with in-flight dedup"
```

---

### Task 4: Create `ensure-descriptions.ts` with tests

**Files:**
- Create: `src/responder/ensure-descriptions.ts`
- Create: `src/responder/ensure-descriptions.test.ts`

**Step 1: Write the failing tests**

Create `src/responder/ensure-descriptions.test.ts`：

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { collectReferenceIds } from './ensure-descriptions.js'
import type { ParsedSegment } from '../types/message-segments.js'

describe('collectReferenceIds', () => {
  test('returns referenceIds from image, video, record, and file segments', () => {
    const groups: ParsedSegment[][] = [
      [
        { type: 'image', referenceId: '42' },
        { type: 'text', content: 'hello' },
        { type: 'video', referenceId: '99' },
      ],
      [{ type: 'record', referenceId: '7' }],
      [{ type: 'file', referenceId: '3' }],
    ]
    assert.deepEqual(collectReferenceIds(groups), [42, 99, 7, 3])
  })

  test('ignores segments without referenceId', () => {
    const groups: ParsedSegment[][] = [
      [{ type: 'image', url: 'http://example.com/img.jpg' }],
    ]
    assert.deepEqual(collectReferenceIds(groups), [])
  })

  test('ignores non-media segments', () => {
    const groups: ParsedSegment[][] = [
      [
        { type: 'text', content: 'hello' },
        { type: 'face', faceId: 1 },
        { type: 'at', targetId: '123' },
      ],
    ]
    assert.deepEqual(collectReferenceIds(groups), [])
  })

  test('returns empty array for empty input', () => {
    assert.deepEqual(collectReferenceIds([]), [])
  })

  test('returns empty array for messages with no segments', () => {
    assert.deepEqual(collectReferenceIds([[]]), [])
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
node --import tsx/esm --test src/responder/ensure-descriptions.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND`（文件不存在）。

**Step 3: Implement `src/responder/ensure-descriptions.ts`**

```ts
import { prisma } from '../database/client.js'
import type { Message } from '../generated/prisma/client.js'
import type { ParsedSegment } from '../types/message-segments.js'
import { generateDescriptionForMedia } from '../jobs/generate-description.js'
import { log } from '../logger.js'

export function collectReferenceIds(segmentGroups: ParsedSegment[][]): number[] {
  const ids: number[] = []
  for (const segments of segmentGroups) {
    for (const seg of segments) {
      if (
        (seg.type === 'image' || seg.type === 'video' || seg.type === 'record' || seg.type === 'file') &&
        typeof seg.referenceId === 'string'
      ) {
        ids.push(Number(seg.referenceId))
      }
    }
  }
  return ids
}

export async function ensureDescriptions(messages: Message[], timeoutMs: number): Promise<void> {
  const segmentGroups = messages.map((m) => m.content as unknown as ParsedSegment[])
  const allIds = collectReferenceIds(segmentGroups)
  if (allIds.length === 0) return

  const mediaRows = await prisma.media.findMany({
    where: { mediaId: { in: allIds }, description: null },
    select: { mediaId: true },
  })

  const pendingIds = mediaRows.map((r) => r.mediaId)
  if (pendingIds.length === 0) return

  log.debug({ count: pendingIds.length }, '等待媒体描述生成')

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  const all = Promise.allSettled(pendingIds.map((id) => generateDescriptionForMedia(id)))

  await Promise.race([all, timeout])
}
```

**Step 4: Run tests to verify they pass**

```bash
node --import tsx/esm --test src/responder/ensure-descriptions.test.ts
```

Expected: 5 tests PASS。

**Step 5: Verify TypeScript compiles**

```bash
pnpm build
```

Expected: 无报错。

**Step 6: Commit**

```bash
git add src/responder/ensure-descriptions.ts src/responder/ensure-descriptions.test.ts
git commit -m "feat: add ensureDescriptions with timeout and in-flight dedup"
```

---

### Task 5: Integrate `ensureDescriptions` into `context-builder.ts`

**Files:**
- Modify: `src/responder/context-builder.ts`

**Step 1: 修改 `buildContext()` 函数**

在 `getRecentGroupMessages` 调用之后、`resolveMessage` 循环之前，插入 `ensureDescriptions` 调用。

完整修改后的 `src/responder/context-builder.ts`：

```ts
import type { IncomingMessage } from './pipeline.js'
import type { ParsedSegment, ReplySegment } from '../types/message-segments.js'
import { getRecentGroupMessages, getMessageById } from '../database/messages.js'
import { resolveMessage } from '../media/message-resolver.js'
import { ensureDescriptions } from './ensure-descriptions.js'
import { config } from '../config/index.js'

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function segmentsToText(segments: ParsedSegment[]): string {
  return segments
    .map((seg) => {
      switch (seg.type) {
        case 'text':
          return seg.content
        case 'image':
          return seg.summary ? `[图片: ${seg.summary}]` : '[图片]'
        case 'video':
          return seg.description ? `[视频: ${seg.description}]` : '[视频]'
        case 'record':
          return seg.description ? `[语音: ${seg.description}]` : '[语音]'
        case 'file':
          return seg.fileName ? `[文件: ${seg.fileName}]` : '[文件]'
        case 'face':
          return seg.name ? `[表情: ${seg.name}]` : '[表情]'
        case 'at':
          return seg.targetName ? `@${seg.targetName}` : `@${seg.targetId}`
        case 'reply':
          return ''
        case 'raw':
          return `[${seg.originalType}]`
        default:
          return ''
      }
    })
    .join('')
    .trim()
}

export async function buildContext(msg: IncomingMessage, contextLimit: number): Promise<string> {
  const lines: string[] = []

  const replySegment = msg.segments.find((s): s is ReplySegment => s.type === 'reply')
  if (replySegment) {
    const replyMsgId = Number(replySegment.messageId)
    const quotedMsg = await getMessageById(msg.groupId, replyMsgId)
    if (quotedMsg) {
      const resolvedSegments = await resolveMessage(quotedMsg)
      const nickname = quotedMsg.senderGroupNickname ?? quotedMsg.senderNickname
      const text = segmentsToText(resolvedSegments)
      lines.push(`[被引用消息] ${nickname}: ${text}`)
      lines.push('')
    }
  }

  const recentMessages = await getRecentGroupMessages(msg.groupId, contextLimit)

  // 等待最近 N 条消息的媒体描述生成完毕（超时后降级为占位符）
  const waitMessages = recentMessages.slice(-config.replyMediaWaitN)
  await ensureDescriptions(waitMessages, config.replyMediaTimeoutMs)

  for (const dbMsg of recentMessages) {
    const resolvedSegments = await resolveMessage(dbMsg)
    const nickname = dbMsg.senderGroupNickname ?? dbMsg.senderNickname
    const time = formatTime(dbMsg.createdAt)
    const text = segmentsToText(resolvedSegments)
    if (text) lines.push(`[${time}] ${nickname}: ${text}`)
  }

  return lines.join('\n')
}

export function extractTriggerText(segments: ParsedSegment[]): string {
  return segments
    .filter((s) => s.type === 'text')
    .map((s) => (s.type === 'text' ? s.content : ''))
    .join(' ')
    .trim()
}
```

重点：`recentMessages` 是 ASC 排序（`getRecentGroupMessages` 用 `orderBy: { createdAt: 'asc' }`），所以 `slice(-N)` 取的正是最近 N 条。

**Step 2: Verify TypeScript compiles**

```bash
pnpm build
```

Expected: 无报错。

**Step 3: Run all tests**

```bash
node --import tsx/esm --test src/utils/in-flight.test.ts src/responder/ensure-descriptions.test.ts src/media/media-hash.test.ts
```

Expected: 全部 PASS。

**Step 4: Commit**

```bash
git add src/responder/context-builder.ts
git commit -m "feat: wait for media descriptions before building reply context"
```

---

## Verification Checklist

手动验证（需要运行中的 bot）：

1. **正常场景**：旧消息里有图片（早已有描述）→ `ensureDescriptions` 立即返回，无额外 LLM 调用（观察日志无 `等待媒体描述生成` 输出）
2. **竞态场景**：发图片后立刻 @bot → 日志出现 `等待媒体描述生成`，回复里应包含图片描述而非 `[图片]`
3. **超时场景**：人为让 LLM 极慢（或断网）→ 超时后降级，bot 正常回复（含 `[图片]` 占位符），不报错
4. **去重验证**：图片到达时队列已在处理 → 日志里该 mediaId 只出现一次 `媒体描述已生成`
