import type { Message } from '../generated/prisma/client.js'
import { prisma } from '../database/client.js'
import { ensureMessageReadyForAgent as defaultEnsureReady } from '../media/ensure-message-ready.js'
import { createLogger } from '../logger.js'
import type { IngestedMessage } from './core.js'

const log = createLogger('INGRESS')

export type PendingReadyMessage =
  | Omit<Extract<IngestedMessage, { kind: 'group' }>, 'renderedText'>
  | Omit<Extract<IngestedMessage, { kind: 'private' }>, 'renderedText'>

export interface MessageReadyDispatcherDeps {
  onMessageReady?: (input: IngestedMessage) => void | Promise<void>
  loadMessage?: (messageRowId: number) => Promise<Message | null>
  ensureReady?: (message: Message) => Promise<{ renderedText: string; fromFrozen: boolean }>
}

export interface MessageReadyDispatcher {
  schedule(input: PendingReadyMessage): void
  drain(): Promise<void>
}

function scopeKey(input: PendingReadyMessage): string {
  if (input.kind === 'group') return `group:${input.groupId}`
  return `private:${input.peerId}`
}

export function createMessageReadyDispatcher(deps: MessageReadyDispatcherDeps): MessageReadyDispatcher {
  const chains = new Map<string, Promise<void>>()
  const loadMessage = deps.loadMessage ?? ((messageRowId) => prisma.message.findUnique({ where: { id: messageRowId } }))
  const ensureReady = deps.ensureReady ?? defaultEnsureReady

  async function deliver(input: PendingReadyMessage): Promise<void> {
    if (!deps.onMessageReady) return

    const messageRow = await loadMessage(input.messageRowId)
    if (!messageRow) return
    const ready = await ensureReady(messageRow)

    if (input.kind === 'group') {
      await deps.onMessageReady({
        ...input,
        renderedText: ready.renderedText,
      })
      return
    }

    await deps.onMessageReady({
      ...input,
      renderedText: ready.renderedText,
    })
  }

  return {
    schedule(input) {
      if (!deps.onMessageReady) return

      const key = scopeKey(input)
      const previous = chains.get(key) ?? Promise.resolve()
      const next = previous
        .catch(() => undefined)
        .then(() => deliver(input))
        .catch((error) => {
          log.error({ error, messageRowId: input.messageRowId, scope: key }, '消息媒体补全后入队失败')
        })
        .finally(() => {
          if (chains.get(key) === next) {
            chains.delete(key)
          }
        })
      chains.set(key, next)
    },

    async drain() {
      await Promise.allSettled([...chains.values()])
    },
  }
}
