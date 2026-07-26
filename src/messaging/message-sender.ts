import type {
  SendNapcatResult,
  NapcatSegment,
  SendTarget,
} from './napcat-sender.js'

export interface MessageSender {
  sendSegments(params: {
    target: SendTarget
    segments: NapcatSegment[]
  }): Promise<SendNapcatResult>
}

class NapcatMessageSender implements MessageSender {
  async sendSegments(params: { target: SendTarget; segments: NapcatSegment[] }): Promise<SendNapcatResult> {
    const { sendSegmentsRaw } = await import('./napcat-sender.js')
    return sendSegmentsRaw(params.target, params.segments)
  }
}

export function createMessageSender(): MessageSender {
  return new NapcatMessageSender()
}

export const messageSender: MessageSender = createMessageSender()
