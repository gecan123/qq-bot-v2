import type { Receive } from 'node-napcat-ts'
import type { WSSendReturn } from 'node-napcat-ts'
import type { ParsedSegment } from '../types/message-segments.js'

type NapcatMessage = WSSendReturn['get_msg']
type ReceiveSegment = Receive[keyof Receive]

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
        summary: data.summary,
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

    default:
      return {
        type: 'raw',
        originalType: msg.type,
        data: msg.data,
      }
  }
}

export function parseMessage(qqMsg: NapcatMessage): ParsedMessage {
  const segments = qqMsg.message
    .map(parseSegment)
    .filter((s): s is ParsedSegment => s !== undefined)

  const time = qqMsg.time > 1_000_000_000_000 ? Math.floor(qqMsg.time / 1000) : qqMsg.time

  return {
    time,
    messageId: qqMsg.message_id,
    senderId: qqMsg.sender.user_id,
    senderNickname: qqMsg.sender.nickname,
    senderGroupNickname: qqMsg.sender.card || undefined,
    content: segments,
  }
}
