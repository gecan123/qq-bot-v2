import type { BotOwner } from '../config/index.js'
import { prisma } from '../database/client.js'
import type { MailboxCursors } from './mailbox.js'
import {
  MAX_GOAL_OBJECTIVE_CHARS,
  MAX_GOAL_TOKEN_BUDGET,
  type GoalControlCommand,
  type GoalMutationResult,
  type GoalStore,
} from './goal-store.js'

export interface GoalControlHandlingResult {
  handled: boolean
  command?: GoalControlCommand
  mutation?: GoalMutationResult
  error?: string
}

export function createStartupGoalControlGate<T extends { messageRowId: number }>(
  process: (event: T) => Promise<void>,
): {
  submit(event: T): Promise<void>
  finishReplay(): Promise<void>
} {
  let replayComplete = false
  const pending: T[] = []
  return {
    async submit(event) {
      if (replayComplete) {
        await process(event)
      } else {
        pending.push(event)
      }
    },
    async finishReplay() {
      if (replayComplete) return
      while (pending.length > 0) {
        const batch = pending.splice(0).sort((a, b) => a.messageRowId - b.messageRowId)
        for (const event of batch) await process(event)
      }
      replayComplete = true
    },
  }
}

export function parseGoalControlCommand(text: string): GoalControlCommand | null {
  const trimmed = text.trim()
  if (!/^\/goal(?:\s|$)/i.test(trimmed)) return null
  const args = trimmed.slice('/goal'.length).trim()
  if (!args) return { action: 'status' }

  const lower = args.toLowerCase()
  if (['clear', 'cancel', 'off'].includes(lower)) return { action: 'clear' }
  if (lower === 'pause') return { action: 'pause' }
  if (lower === 'resume') return { action: 'resume', tokenBudget: null }
  if (lower.startsWith('resume ')) {
    const tokenBudget = parseTokenBudgetOnly(args.slice('resume'.length).trim())
    if (tokenBudget == null) throw new Error('用法: /goal resume --tokens <正整数>')
    return { action: 'resume', tokenBudget }
  }

  const parsed = parseSetArgs(args)
  if (!parsed.objective) throw new Error('goal objective 不能为空。')
  if (parsed.objective.length > MAX_GOAL_OBJECTIVE_CHARS) {
    throw new Error(`goal objective 最多 ${MAX_GOAL_OBJECTIVE_CHARS} 字符。`)
  }
  return { action: 'set', ...parsed }
}

export async function tryHandleOwnerGoalMessage(input: {
  owner: BotOwner | null
  peerId: number
  senderId: number
  messageRowId: number
  renderedText: string
  goalStore: GoalStore
}): Promise<GoalControlHandlingResult> {
  if (!input.owner || input.peerId !== input.owner.qq || input.senderId !== input.owner.qq) {
    return { handled: false }
  }
  let command: GoalControlCommand | null
  try {
    command = parseGoalControlCommand(input.renderedText)
  } catch (error) {
    return {
      handled: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (!command) return { handled: false }
  const mutation = await input.goalStore.applyControl({
    messageRowId: input.messageRowId,
    command,
  })
  return { handled: true, command, mutation }
}

export async function replayOwnerGoalCommands(input: {
  owner: BotOwner | null
  mailboxCursors: Readonly<MailboxCursors>
  legacyLastWakeAt: Date | null
  goalStore: GoalStore
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
      searchText: { startsWith: '/goal', mode: 'insensitive' },
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
    const result = await tryHandleOwnerGoalMessage({
      owner: input.owner,
      peerId: Number(row.sceneExternalId),
      senderId: Number(row.senderId),
      messageRowId: row.id,
      renderedText: row.resolvedText ?? row.searchText ?? '',
      goalStore: input.goalStore,
    })
    if (result.handled) handled++
  }
  return { matched: rows.length, handled }
}

function parseSetArgs(args: string): { objective: string; tokenBudget: number | null } {
  const match = /^--tokens\s+(\d+)\s+([\s\S]+)$/i.exec(args)
  if (!match) return { objective: args.trim(), tokenBudget: null }
  const tokenBudget = validateTokenBudget(Number(match[1]))
  return { objective: match[2]!.trim(), tokenBudget }
}

function parseTokenBudgetOnly(args: string): number | null {
  const match = /^--tokens\s+(\d+)$/i.exec(args)
  return match ? validateTokenBudget(Number(match[1])) : null
}

function validateTokenBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_GOAL_TOKEN_BUDGET) {
    throw new Error(`goal token budget 必须是 1..${MAX_GOAL_TOKEN_BUDGET} 的整数。`)
  }
  return value
}
