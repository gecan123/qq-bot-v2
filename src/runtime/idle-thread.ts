import { prisma } from '../database/client.js'
import { createAgentChatFn } from '../agent/runtime.js'
import { buildLlmRequest } from '../agent/build-llm-request.js'
import { createSceneAgentContext } from '../agent/scene-agent-context-store.js'
import { innerJournalStore, type InnerJournalEntry } from '../world-model/inner-journal-store.js'
import { getAgentProfile } from '../config/agent-profiles.js'
import { loadPrompt } from '../config/prompt-loader.js'
import { buildSystemPrompt } from '../responder/agent-session.js'
import { makeQqGroupSceneId } from './agent-runtime-types.js'
import type { AgentMessage } from '../agent/types.js'
import { createLogger } from '../logger.js'

const log = createLogger('IDLE_THREAD')

const IDLE_REFLECTION_INSTRUCTION = loadPrompt('./prompts/idle-reflection.md')

export interface IdleThreadOptions {
  /** 启动后多久跑第一次,默认 60_000 (1 min,避免和启动流程抢资源)。 */
  initialDelayMs?: number
  /** 多久跑一次,0 = 关闭。设计建议 30 min,可视实测调。 */
  intervalMs: number
  /** 哪个时间窗内有事件的 scene 算"活跃",默认 24h。 */
  activeWithinHours?: number
  /** 注入提示中的"最近 journal"取多少条,默认 3。 */
  recentJournalLimit?: number
  /** scene 解析:把当前活跃的 group 列表给 IdleThread。 */
  groupIds: number[]
  now?: () => Date
}

/**
 * Phase 1c: bot 私下思考的定时入口。
 *
 * 设计要点 (Phase 1c 决策已记入 design doc):
 * - **不**走 emitRuntimeEvent / 不新加 idle_tick event kind。直接独立 cron。
 * - per-scene in-flight set 防同 scene 并发(单次 tick 还没跑完下次 tick 又触发同 scene)。
 * - 不写回 AgentContext,只 append inner_journal 表。
 * - 模型默认走 agentModel (Sonnet) 共享 IdleThread 自身 lineage cache。
 * - kill switch: intervalMs <= 0 整个机制不启动。
 */
export function startIdleThread(options: IdleThreadOptions): NodeJS.Timeout[] {
  if (options.intervalMs <= 0 || options.groupIds.length === 0) return []

  const initialDelayMs = options.initialDelayMs ?? 60_000
  const activeWithinHours = options.activeWithinHours ?? 24
  const recentJournalLimit = options.recentJournalLimit ?? 3
  const inFlight = new Set<string>()

  const runOnce = async () => {
    const activeSceneIds = await listRecentlyActiveScenes({
      groupIds: options.groupIds,
      withinHours: activeWithinHours,
      now: options.now,
    })
    for (const sceneId of activeSceneIds) {
      if (inFlight.has(sceneId)) continue
      inFlight.add(sceneId)
      handleIdleTick({ sceneId, recentJournalLimit })
        .catch((err) => log.warn({ err, sceneId }, 'idle_tick_failed'))
        .finally(() => inFlight.delete(sceneId))
    }
  }

  const timers: NodeJS.Timeout[] = []
  timers.push(setTimeout(() => void runOnce(), initialDelayMs))
  timers.push(setInterval(() => void runOnce(), options.intervalMs))
  log.info(
    { intervalMs: options.intervalMs, initialDelayMs, activeWithinHours, groupCount: options.groupIds.length },
    'idle_thread_started',
  )
  return timers
}

interface ListActiveScenesOptions {
  groupIds: number[]
  withinHours: number
  now?: () => Date
}

/**
 * 通过 scene_agent_contexts.updated_at 找最近 N 小时被改过的 scene。
 * 这反映"reactive @ 真的发生过"——而不是 messages 表里所有摄入消息。
 */
async function listRecentlyActiveScenes(options: ListActiveScenesOptions): Promise<string[]> {
  const now = options.now?.() ?? new Date()
  const cutoff = new Date(now.getTime() - options.withinHours * 60 * 60 * 1000)
  const sceneIds = options.groupIds.map((g) => makeQqGroupSceneId(g))
  const rows = await prisma.sceneAgentContext.findMany({
    where: {
      sceneId: { in: sceneIds },
      updatedAt: { gte: cutoff },
    },
    select: { sceneId: true },
  })
  return rows.map((r) => r.sceneId)
}

interface HandleIdleTickInput {
  sceneId: string
  recentJournalLimit: number
}

async function handleIdleTick(input: HandleIdleTickInput): Promise<void> {
  const groupId = parseGroupIdFromSceneId(input.sceneId)
  if (groupId == null) {
    log.debug({ sceneId: input.sceneId }, 'idle_tick_skipped_non_group_scene')
    return
  }

  const ctx = await createSceneAgentContext({ sceneId: input.sceneId })
  const snapshot = await ctx.getSnapshot()

  // 空 context 直接跳过——bot 还没在这个 scene 说过话,没什么可反思的
  if (snapshot.messages.length === 0) {
    log.debug({ sceneId: input.sceneId }, 'idle_tick_skipped_empty_context')
    return
  }

  const recentJournal = await innerJournalStore.last({
    sceneId: input.sceneId,
    limit: input.recentJournalLimit,
  })

  const profile = getAgentProfile(groupId)
  const systemPrompt = buildSystemPrompt(profile.persona, IDLE_REFLECTION_INSTRUCTION)

  const suffix: AgentMessage[] = [
    {
      role: 'user',
      content: buildIdleTickUserMessage(recentJournal),
    },
  ]

  const { messages } = buildLlmRequest(snapshot, suffix)
  const chatFn = createAgentChatFn({ reasoningEffort: 'low' })
  const turnResult = await chatFn({ systemPrompt, history: messages, tools: [] })

  const text = extractText(turnResult)
  if (!text) {
    log.info({ sceneId: input.sceneId, turnType: turnResult.type }, 'idle_tick_no_text')
    return
  }

  const trimmed = text.trim().slice(0, 800)
  if (trimmed.length === 0) return

  await innerJournalStore.create({
    sceneId: input.sceneId,
    content: trimmed,
    sourceEventIds: [],
  })

  log.info(
    {
      direction: 'internal',
      actor: 'bot',
      category: 'inner_journal',
      flow: 'idle_thread',
      sceneId: input.sceneId,
      groupId,
      contentLen: trimmed.length,
      hadRecentJournal: recentJournal.length > 0,
    },
    'idle_journal_written',
  )
}

export function buildIdleTickUserMessage(recentJournal: InnerJournalEntry[]): string {
  if (recentJournal.length === 0) {
    return '[内省时刻] 写一段私下笔记。'
  }
  const lines = recentJournal
    .map((entry) => `- ${entry.createdAt.toISOString()}: ${entry.content}`)
    .join('\n')
  return `[内省时刻]\n你最近的私下笔记:\n${lines}\n\n现在再写一段。`
}

function extractText(turnResult: { type: string; content?: string }): string | null {
  if (turnResult.type === 'text' && typeof turnResult.content === 'string') {
    return turnResult.content
  }
  // 模型在没有工具的情况下偶尔会硬塞个 tool_calls 同时带 content; 我们也接受
  if (turnResult.type === 'tool_calls' && typeof turnResult.content === 'string') {
    return turnResult.content
  }
  return null
}

export function parseGroupIdFromSceneId(sceneId: string): number | null {
  const prefix = 'qq_group:'
  if (!sceneId.startsWith(prefix)) return null
  const rest = sceneId.slice(prefix.length)
  const parsed = Number(rest)
  return Number.isSafeInteger(parsed) ? parsed : null
}
