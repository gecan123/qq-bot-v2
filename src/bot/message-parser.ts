import type { Receive } from 'node-napcat-ts'
import type { WSSendReturn } from 'node-napcat-ts'
import type { ForwardMessageItem, ForwardSegment, ParsedSegment } from '../types/message-segments.js'

type NapcatMessage = WSSendReturn['get_msg']
type ReceiveSegment = Receive[keyof Receive]

export interface ForwardMessageLoader {
  get_forward_msg(args: { message_id: string }): Promise<{ messages: NapcatMessage[] }>
  get_msg(args: { message_id: number }): Promise<NapcatMessage>
}

interface ForwardParseContext {
  loader: ForwardMessageLoader
  messageCache: Map<number, Promise<NapcatMessage | undefined>>
  remainingItems: number
}

const MAX_FORWARD_DEPTH = 3
const MAX_FORWARD_ITEMS = 50
const MAX_FORWARD_TEXT_CHARS_PER_ITEM = 2_000

export interface ParsedMessage {
  time: number
  messageId: number
  senderId: number
  senderNickname: string
  senderGroupNickname?: string
  content: ParsedSegment[]
}

function parseSegment(msg: ReceiveSegment): ParsedSegment | undefined {
  switch (msg.type) {
    case 'text': {
      const text = msg.data.text?.trim()
      if (!text) return undefined
      return { type: 'text', content: text }
    }

    case 'image': {
      const data = msg.data as {
        url?: string
        file_size?: string
        file?: string
        summary?: string
        sub_type?: number
      }
      return {
        type: 'image',
        url: data.url,
        fileSize: data.file_size,
        fileName: data.file,
        mediaDescription: data.summary ? { summary: data.summary } : undefined,
        subType: data.sub_type,
      }
    }

    case 'face':
      return {
        type: 'face',
        faceId: parseInt(msg.data.id) || 0,
        name: msg.data.raw?.faceText,
      }

    case 'at':
      return {
        type: 'at',
        targetId: String(msg.data.qq),
      }

    case 'video': {
      const data = msg.data as {
        url?: string
        file?: string
        file_size?: string
      }
      return {
        type: 'video',
        url: data.url,
        fileName: data.file,
        fileSize: data.file_size,
      }
    }

    case 'record': {
      const data = msg.data as {
        url?: string
        file?: string
        file_size?: string
      }
      return {
        type: 'record',
        url: data.url,
        fileName: data.file,
        fileSize: data.file_size,
      }
    }

    case 'file': {
      const data = msg.data as {
        url?: string
        file?: string
        file_id?: string
        file_size?: string
      }
      return {
        type: 'file',
        url: data.url,
        fileName: data.file,
        fileId: data.file_id,
        fileSize: data.file_size,
      }
    }

    case 'reply':
      return {
        type: 'reply',
        messageId: String(msg.data.id),
      }

    case 'json': {
      const raw = (msg.data as { data?: string }).data ?? ''
      try {
        const parsed = JSON.parse(raw) as {
          prompt?: string
          meta?: {
            news?: { title?: string; desc?: string; jumpUrl?: string; tag?: string }
            detail_1?: { title?: string; desc?: string; url?: string; qqdocurl?: string }
          }
        }
        const news = parsed.meta?.news
        const detail = parsed.meta?.detail_1
        return {
          type: 'json_card',
          title: news?.title ?? detail?.title,
          desc: news?.desc ?? detail?.desc,
          url: news?.jumpUrl ?? detail?.qqdocurl ?? detail?.url,
          source: news?.tag,
          prompt: parsed.prompt,
        }
      } catch {
        return { type: 'json_card', prompt: raw.slice(0, 100) }
      }
    }

    case 'forward':
      return {
        type: 'forward',
        forwardId: String(msg.data.id),
        items: [],
      }

    default:
      return {
        type: 'raw',
        originalType: msg.type,
        data: msg.data,
      }
  }
}

function normalizeTime(time: number): number {
  return time > 1_000_000_000_000 ? Math.floor(time / 1000) : time
}

function isNapcatMessage(value: unknown): value is NapcatMessage {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.message_id === 'number' &&
    typeof record.time === 'number' &&
    Array.isArray(record.message) &&
    !!record.sender &&
    typeof record.sender === 'object'
  )
}

function embeddedForwardMessages(segment: ReceiveSegment): NapcatMessage[] | undefined {
  if (segment.type !== 'forward') return undefined
  const content = (segment.data as { content?: unknown }).content
  if (!Array.isArray(content) || !content.every(isNapcatMessage)) return undefined
  return content
}

async function getCanonicalMessage(
  messageId: number,
  context: ForwardParseContext,
): Promise<NapcatMessage | undefined> {
  const cached = context.messageCache.get(messageId)
  if (cached) return cached

  const pending = context.loader.get_msg({ message_id: messageId }).catch(() => undefined)
  context.messageCache.set(messageId, pending)
  return pending
}

function senderName(message: NapcatMessage): string | undefined {
  const card = message.sender.card?.trim()
  const nickname = message.sender.nickname?.trim()
  return card || nickname || undefined
}

async function parseForwardItem(
  source: NapcatMessage,
  context: ForwardParseContext,
  depth: number,
): Promise<{ item: ForwardMessageItem; truncated: boolean }> {
  const canonical = await getCanonicalMessage(source.message_id, context)
  const message = canonical ?? source
  const parsedContent = await parseSegmentsWithForwards(message.message, context, depth)
  const { content, truncated } = truncateForwardText(parsedContent)
  return {
    item: {
      messageId: String(message.message_id),
      senderId: String(message.sender.user_id),
      senderName: senderName(message),
      time: normalizeTime(message.time),
      content,
    },
    truncated,
  }
}

function truncateForwardText(segments: ParsedSegment[]): { content: ParsedSegment[]; truncated: boolean } {
  let remaining = MAX_FORWARD_TEXT_CHARS_PER_ITEM
  let truncated = false
  const content = segments.map((segment): ParsedSegment => {
    if (segment.type !== 'text') return segment
    if (segment.content.length <= remaining) {
      remaining -= segment.content.length
      return segment
    }
    truncated = true
    const text = remaining > 0 ? `${segment.content.slice(0, remaining)}…` : ''
    remaining = 0
    return { ...segment, content: text }
  })
  return { content, truncated }
}

async function parseForwardSegment(
  segment: ReceiveSegment,
  context: ForwardParseContext,
  depth: number,
): Promise<ForwardSegment> {
  if (segment.type !== 'forward') throw new Error('parseForwardSegment requires forward segment')
  const forwardId = String(segment.data.id)
  if (depth >= MAX_FORWARD_DEPTH) {
    return { type: 'forward', forwardId, items: [], truncated: true }
  }

  let messages = embeddedForwardMessages(segment)
  if (!messages) {
    try {
      messages = (await context.loader.get_forward_msg({ message_id: forwardId })).messages
    } catch {
      return { type: 'forward', forwardId, items: [], unavailable: true }
    }
  }

  const items: ForwardMessageItem[] = []
  let truncated = false
  for (const message of messages) {
    if (!isNapcatMessage(message)) continue
    if (context.remainingItems <= 0) {
      truncated = true
      break
    }
    context.remainingItems -= 1
    const parsed = await parseForwardItem(message, context, depth + 1)
    items.push(parsed.item)
    if (parsed.truncated) truncated = true
  }
  return {
    type: 'forward',
    forwardId,
    items,
    ...(truncated ? { truncated: true } : {}),
  }
}

async function parseSegmentsWithForwards(
  segments: ReceiveSegment[],
  context: ForwardParseContext,
  depth: number,
): Promise<ParsedSegment[]> {
  const output: ParsedSegment[] = []
  for (const segment of segments) {
    const parsed = segment.type === 'forward'
      ? await parseForwardSegment(segment, context, depth)
      : parseSegment(segment)
    if (parsed) output.push(parsed)
  }
  return output
}

export function parseMessage(qqMsg: NapcatMessage): ParsedMessage {
  const segments = qqMsg.message
    .map(parseSegment)
    .filter((s): s is ParsedSegment => s !== undefined)

  const time = normalizeTime(qqMsg.time)

  return {
    time,
    messageId: qqMsg.message_id,
    senderId: qqMsg.sender.user_id,
    senderNickname: qqMsg.sender.nickname,
    senderGroupNickname: qqMsg.sender.card || undefined,
    content: segments,
  }
}

export async function parseMessageWithForwards(
  qqMsg: NapcatMessage,
  loader: ForwardMessageLoader,
): Promise<ParsedMessage> {
  const parsed = parseMessage(qqMsg)
  return {
    ...parsed,
    content: await parseSegmentsWithForwards(qqMsg.message, {
      loader,
      messageCache: new Map(),
      remainingItems: MAX_FORWARD_ITEMS,
    }, 0),
  }
}
