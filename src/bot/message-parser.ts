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
      const data = msg.data as { url?: string; file_size?: string }
      return {
        type: 'image',
        url: data.url ?? '',
        fileSize: data.file_size,
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

    case 'reply':
      return {
        type: 'reply',
        messageId: String(msg.data.id),
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
