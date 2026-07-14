import type { AgentMessage } from './agent-context.types.js'

const MAILBOX_KEY_PATTERN = /^qq_(?:group|private):\d+$/

export function findPendingMailboxThroughRowId(
  messages: readonly AgentMessage[],
  mailbox: string,
): number | null {
  assertMailboxKey(mailbox)

  let disclosed = 0
  let handled = 0

  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue

    let payload: unknown
    try {
      payload = JSON.parse(message.content)
    } catch {
      continue
    }

    if (!isRecord(payload) || payload.mailbox !== mailbox) continue
    if (!isPositiveSafeInteger(payload.throughRowId)) continue

    if (payload.event === 'inbox_update') {
      disclosed = Math.max(disclosed, payload.throughRowId)
    } else if (payload.event === 'mailbox_handled') {
      handled = Math.max(handled, payload.throughRowId)
    }
  }

  return disclosed > handled ? disclosed : null
}

export function renderMailboxHandledEvent(mailbox: string, throughRowId: number): string {
  assertMailboxKey(mailbox)
  if (!isPositiveSafeInteger(throughRowId)) {
    throw new RangeError('throughRowId must be a positive safe integer')
  }

  return JSON.stringify({ event: 'mailbox_handled', mailbox, throughRowId })
}

function assertMailboxKey(mailbox: string): void {
  if (!MAILBOX_KEY_PATTERN.test(mailbox)) {
    throw new TypeError(`invalid mailbox key: ${mailbox}`)
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
