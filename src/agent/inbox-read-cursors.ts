const INBOX_MAILBOX_KEY_PATTERN = /^qq_(?:group|private):\d+$/

export type InboxReadCursors = Record<string, number>

export function parseInboxReadCursors(value: unknown): InboxReadCursors {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('inbox read cursors must be an object')
  }

  const cursors: InboxReadCursors = {}
  for (const [mailbox, cursor] of Object.entries(value as Record<string, unknown>)) {
    if (!INBOX_MAILBOX_KEY_PATTERN.test(mailbox)) {
      throw new TypeError(`invalid inbox mailbox key: ${mailbox}`)
    }
    if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) {
      throw new TypeError(`invalid inbox read cursor for ${mailbox}`)
    }
    cursors[mailbox] = cursor as number
  }
  return cursors
}

export function advanceInboxReadCursor(
  cursors: Readonly<InboxReadCursors>,
  mailbox: string,
  throughRowId: number,
): InboxReadCursors {
  if (!INBOX_MAILBOX_KEY_PATTERN.test(mailbox)) {
    throw new TypeError(`invalid inbox mailbox key: ${mailbox}`)
  }
  if (!Number.isSafeInteger(throughRowId) || throughRowId <= 0) {
    throw new TypeError('inbox throughRowId must be a positive safe integer')
  }
  return {
    ...cursors,
    [mailbox]: Math.max(cursors[mailbox] ?? 0, throughRowId),
  }
}
