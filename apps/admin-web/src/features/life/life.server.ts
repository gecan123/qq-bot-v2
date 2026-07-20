import '@tanstack/react-start/server-only'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAdminPrisma } from '../../server/db.server.js'
import { getWorkspaceRoot } from '../../server/paths.server.js'
import { lifeSnapshotSchema, type LifeSnapshot } from './life.schema.js'

export async function loadLifeSnapshot(now = new Date()): Promise<LifeSnapshot> {
  const db = getAdminPrisma()
  const workspace = getWorkspaceRoot()
  const [goal, runtime, inboxReadCount, agendaRaw, schedulesRaw, tasksRaw] = await Promise.all([
    db.botAgentGoal.findUnique({ where: { id: 1 } }),
    db.botAgentRuntimeState.findUnique({ where: { id: 1 }, select: { lastWakeAt: true, updatedAt: true, qqConversationFocus: true, mailboxCursors: true, activeToolCapabilities: true } }),
    readInboxReadCursorCount(db),
    readOptional(join(workspace, 'life', 'agenda.md')),
    readJson(join(workspace, 'runtime', 'schedules.json')),
    readJson(join(workspace, 'runtime', 'background-tasks.json')),
  ])
  const schedules = objectArray(schedulesRaw, 'schedules').slice(0, 50).map((row, index) => ({
    id: text(row.id, `schedule-${index + 1}`), label: text(row.label, text(row.reason, '未命名计划')),
    status: text(row.status, 'scheduled'), nextRunAt: nullableText(row.nextRunAt ?? row.dueAt),
  }))
  const backgroundTasks = objectArray(tasksRaw, 'tasks').slice(-40).reverse().map((row, index) => ({
    id: text(row.id, `task-${index + 1}`), toolName: text(row.toolName, 'unknown'), description: text(row.description, '').slice(0, 360),
    status: text(row.status, 'unknown'), attempt: number(row.attempt), updatedAt: nullableText(row.updatedAt),
    summary: nullableText(row.resultSummary ?? row.error)?.slice(0, 360) ?? null,
  }))
  const notes = [
    'todo 工具列表是进程内临时状态，重启后会清空，因此这里不把它伪装成持久任务。',
    '后台任务文件按原始 JSON 只读解析；不会实例化 registry，以免触发恢复状态写入。',
    'Agenda 直接读取文件；缺失时不会调用 ensure/create。',
  ]
  return lifeSnapshotSchema.parse({
    schemaVersion: 1, generatedAt: now.toISOString(),
    goal: goal && {
      goalId: goal.goalId, objective: goal.objective, origin: goal.origin, motivation: goal.motivation, status: goal.status,
      completionCriteria: goal.completionCriteria, currentCommitment: goal.currentCommitment, completionEvidence: goal.completionEvidence,
      tokenBudget: goal.tokenBudget, tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds, roundsUsed: goal.roundsUsed,
      revision: goal.revision, blockerKey: goal.blockerKey, blockerTurns: goal.blockerTurns, blockedReason: goal.blockedReason, updatedAt: goal.updatedAt.toISOString(),
    },
    agenda: { exists: agendaRaw !== null, markdown: agendaRaw ?? '', sections: countSections(agendaRaw ?? '') },
    schedules, backgroundTasks,
    runtime: {
      lastWakeAt: runtime?.lastWakeAt?.toISOString() ?? null, updatedAt: runtime?.updatedAt.toISOString() ?? null,
      focus: runtime?.qqConversationFocus ?? null, mailboxCount: objectSize(runtime?.mailboxCursors),
      inboxReadCount, capabilities: stringArray(runtime?.activeToolCapabilities),
    }, notes,
  })
}

async function readOptional(path: string): Promise<string | null> { try { return await readFile(path, 'utf8') } catch { return null } }
async function readJson(path: string): Promise<unknown> { const raw = await readOptional(path); if (!raw) return null; try { return JSON.parse(raw) } catch { return null } }
function objectArray(value: unknown, key: string): Array<Record<string, unknown>> { if (!value || typeof value !== 'object') return []; const rows = (value as Record<string, unknown>)[key]; return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object') : [] }
function text(value: unknown, fallback: string): string { return typeof value === 'string' ? value : fallback }
function nullableText(value: unknown): string | null { return typeof value === 'string' ? value : null }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
function objectSize(value: unknown): number { return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0 }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
function countSections(markdown: string): Record<string, number> { const out: Record<string, number> = {}; let current = 'Preamble'; for (const line of markdown.split('\n')) { const heading = /^##\s+(.+)$/.exec(line); if (heading) { current = heading[1].trim(); out[current] = 0 } else if (/^\s*[-*]\s+\S/.test(line)) out[current] = (out[current] ?? 0) + 1 } return out }
async function readInboxReadCursorCount(db: ReturnType<typeof getAdminPrisma>): Promise<number> { try { const rows = await db.$queryRawUnsafe<Array<{ value: unknown }>>('SELECT inbox_read_cursors AS value FROM bot_agent_runtime_state WHERE id = 1'); return objectSize(rows[0]?.value) } catch { return 0 } }
