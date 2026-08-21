export function classifyFeishuReceive(input: {
  eventId?: string
  messageId: string
  createTime: string
  updateTime?: string
}): { eventKind: 'message' | 'edit'; eventExternalId: string } {
  const edited = input.updateTime != null
    && Number(input.updateTime) > Number(input.createTime)
  return {
    eventKind: edited ? 'edit' : 'message',
    eventExternalId: input.eventId
      ?? (edited
        ? `edit:${input.messageId}:${input.updateTime!}`
        : `message:${input.messageId}`),
  }
}

export function feishuGatewayHealth(connected: boolean, botOpenId: string): {
  status: 200 | 503
  body: { ok: boolean; connected: boolean; botOpenId: string }
} {
  return {
    status: connected ? 200 : 503,
    body: { ok: connected, connected, botOpenId },
  }
}

export class ConversationWorkQueue {
  private readonly chains = new Map<string, Promise<void>>()

  schedule(key: string, task: () => Promise<void>): void {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.chains.set(key, next)
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    }).catch(() => undefined)
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.chains.values()])
  }
}
