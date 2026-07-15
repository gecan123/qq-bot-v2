import type { BotOwner } from '../config/index.js'
import { prisma } from '../database/client.js'
import type { MailboxCursors } from './mailbox.js'

export const MAX_MANUAL_COMPACTION_FOCUS_CHARS = 300

export interface CompactionControlCommand {
  focus?: string
}

export interface CompactionControlEvent {
  scene: 'friend_private' | 'other_private' | 'group'
  peerId: number
  senderId: number
  messageRowId: number
  renderedText: string
}

export interface CompactionControlHandlingResult {
  handled: boolean
  command?: CompactionControlCommand
  duplicate?: boolean
  error?: string
}

type RequestManualCompaction = (focus?: string) => Promise<boolean>

export function parseCompactionControlCommand(text: string): CompactionControlCommand | null {
  const trimmed = text.trim()
  if (!/^\/compact(?:\s|$)/i.test(trimmed)) return null
  const focus = trimmed.slice('/compact'.length).trim()
  if (!focus) return {}
  if (focus.length > MAX_MANUAL_COMPACTION_FOCUS_CHARS) {
    throw new Error(`compact focus 最多 ${MAX_MANUAL_COMPACTION_FOCUS_CHARS} 字符。`)
  }
  return { focus }
}

export function createStartupCompactionControlGate(input: {
  owner: BotOwner | null
  onExecutionError?: (error: unknown, event: CompactionControlEvent) => void
}): {
  submit(event: CompactionControlEvent): Promise<CompactionControlHandlingResult>
  finishReplay(): Promise<void>
  setRuntime(requestManualCompaction: RequestManualCompaction): Promise<void>
} {
  let replayComplete = false
  let requestManualCompaction: RequestManualCompaction | null = null
  let drainPromise = Promise.resolve()
  const acceptedRows = new Set<number>()
  const pending = new Map<number, {
    event: CompactionControlEvent
    command: CompactionControlCommand
  }>()

  const drain = async (): Promise<void> => {
    if (!replayComplete || !requestManualCompaction) return
    drainPromise = drainPromise.then(async () => {
      while (pending.size > 0) {
        const nextRowId = Math.min(...pending.keys())
        const next = pending.get(nextRowId)
        if (!next) continue
        pending.delete(nextRowId)
        try {
          await requestManualCompaction!(next.command.focus)
        } catch (error) {
          input.onExecutionError?.(error, next.event)
        }
      }
    })
    await drainPromise
  }

  return {
    async submit(event) {
      if (
        event.scene !== 'friend_private'
        || !input.owner
        || event.peerId !== input.owner.qq
        || event.senderId !== input.owner.qq
      ) {
        return { handled: false }
      }
      let command: CompactionControlCommand | null
      try {
        command = parseCompactionControlCommand(event.renderedText)
      } catch (error) {
        return {
          handled: true,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      if (!command) return { handled: false }
      if (acceptedRows.has(event.messageRowId)) {
        return { handled: true, command, duplicate: true }
      }
      acceptedRows.add(event.messageRowId)
      pending.set(event.messageRowId, { event, command })
      await drain()
      return { handled: true, command }
    },
    async finishReplay() {
      replayComplete = true
      await drain()
    },
    async setRuntime(nextRequestManualCompaction) {
      requestManualCompaction = nextRequestManualCompaction
      await drain()
    },
  }
}

export async function replayOwnerCompactionCommands(input: {
  owner: BotOwner | null
  mailboxCursors: Readonly<MailboxCursors>
  legacyLastWakeAt: Date | null
  submit: (event: CompactionControlEvent) => Promise<CompactionControlHandlingResult>
}): Promise<{ matched: number; handled: number }> {
  if (!input.owner) return { matched: 0, handled: 0 }
  const mailboxKey = `qq_private:${input.owner.qq}`
  const cursor = input.mailboxCursors[mailboxKey]
  const boundary = cursor != null
    ? { id: { gt: cursor } }
    : input.legacyLastWakeAt
      ? { createdAt: { gt: input.legacyLastWakeAt } }
      : null
  if (!boundary) return { matched: 0, handled: 0 }

  const rows = await prisma.message.findMany({
    where: {
      sceneKind: 'qq_private',
      sceneExternalId: String(input.owner.qq),
      senderId: BigInt(input.owner.qq),
      searchText: { startsWith: '/compact', mode: 'insensitive' },
      ...boundary,
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      senderId: true,
      sceneExternalId: true,
      searchText: true,
      resolvedText: true,
    },
  })

  let handled = 0
  for (const row of rows) {
    const result = await input.submit({
      scene: 'friend_private',
      peerId: Number(row.sceneExternalId),
      senderId: Number(row.senderId),
      messageRowId: row.id,
      renderedText: row.resolvedText ?? row.searchText ?? '',
    })
    if (result.handled) handled++
  }
  return { matched: rows.length, handled }
}
