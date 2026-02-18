import type { ParsedSegment } from '../types/message-segments.js'

export interface IncomingMessage {
  groupId: number
  groupName?: string
  messageId: number
  senderId: number
  senderNickname: string
  segments: ParsedSegment[]
}

export type HandlerResult = 'continue' | 'break'
export type Handler = (msg: IncomingMessage) => Promise<HandlerResult>

export class ResponderPipeline {
  constructor(private handlers: Handler[]) {}

  async handle(msg: IncomingMessage): Promise<void> {
    for (const handler of this.handlers) {
      if ((await handler(msg)) === 'break') break
    }
  }
}
