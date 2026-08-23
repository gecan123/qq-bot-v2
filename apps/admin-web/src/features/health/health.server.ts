import '@tanstack/react-start/server-only'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { checkAgentLedger, createPrismaAgentLedgerCheckSource } from '../../../../../src/ops/agent-ledger-check.js'
import { AGENT_CHECKPOINT_SCHEMA_VERSION } from '../../../../../src/agent/agent-ledger-loader.js'
import { checkAgentMemory } from '../../../../../src/ops/agent-memory-check.js'
import { AGENT_CONTEXT_SURFACE_PATH, readAgentContextSurface } from '../../../../../src/ops/agent-context-surface.js'
import { getAdminPrisma } from '../../server/db.server.js'
import { getRepositoryRoot, getWorkspaceRoot } from '../../server/paths.server.js'
import { healthSnapshotSchema, type HealthSnapshot } from './health.schema.js'
import {
  MAILBOX_WATCHER_STATUS_PATH,
  mailboxWatcherStatusSchema,
} from '../../../../../src/services/mailbox-watcher-status.js'
import { INGRESS_FAILURE_LOG_PATH, readRecentIngressFailures } from '../../../../../src/services/ingress-failure-log.js'

let lastDeepLedgerCheck: HealthSnapshot['deepLedgerCheck'] = null
let deepLedgerCheckPromise: Promise<HealthSnapshot['deepLedgerCheck']> | null = null

export async function loadHealthSnapshot(now = new Date()): Promise<HealthSnapshot> {
  const db = getAdminPrisma()
  const root = getRepositoryRoot()
  const [database, ledger, knowledge, processStatus, surface, mailboxWatcher, ingressFailures, migrationFiles, migrationRows] = await Promise.all([
    checkDatabase(db),
    loadQuickLedgerHealth(db),
    checkAgentMemory({ rootDir: getWorkspaceRoot(), now }),
    inspectBotProcess(join(root, '.bot.pid')),
    readAgentContextSurface(join(root, AGENT_CONTEXT_SURFACE_PATH)),
    readMailboxWatcherStatus(join(root, MAILBOX_WATCHER_STATUS_PATH)),
    readRecentIngressFailures({ path: join(root, INGRESS_FAILURE_LOG_PATH), now }),
    countMigrationFiles(join(root, 'prisma', 'migrations')),
    readMigrationRows(db),
  ])
  const knowledgeIssueCount = knowledge.issues.corruptOrUnsupportedFiles.length
    + knowledge.issues.duplicateIds.length
    + knowledge.issues.selfReferencingSupersedes.length
    + knowledge.issues.unknownSupersedes.length
  const surfaceGeneratedAt = surface.status === 'available' ? surface.surface.generatedAt : null
  const surfaceAgeSeconds = surfaceGeneratedAt === null
    ? null
    : Math.max(0, Math.round((now.getTime() - Date.parse(surfaceGeneratedAt)) / 1_000))
  const warnings: string[] = []
  if (!processStatus.reachable) warnings.push('Bot PID 不可达；这只是进程提示，不能由数据库状态替代。')
  if (!database.ok) warnings.push('PostgreSQL 只读探针失败。')
  if (!ledger.ok) warnings.push('Ledger head 与 checkpoint 快速检查异常。')
  if (lastDeepLedgerCheck?.ok === false) warnings.push('最近一次 canonical ledger 深度完整性检查失败。')
  if (!knowledge.ok) warnings.push('长期状态结构检查失败。')
  if (migrationRows.failed > 0) warnings.push('存在失败的 Prisma migration。')
  if (surface.status !== 'available') warnings.push(`Context surface ${surface.status}。`)
  if (mailboxWatcher.status === 'invalid') warnings.push('Mailbox watcher 状态文件无法读取。')
  if (mailboxWatcher.blockedAtRowId !== null) {
    warnings.push(`Mailbox 卡在 row ${mailboxWatcher.blockedAtRowId}，已连续失败 ${mailboxWatcher.consecutiveFailures} 次。`)
  }
  if (ingressFailures.status === 'invalid') warnings.push('入站失败日志无法读取，最近失败计数不可用。')
  if (ingressFailures.truncated) warnings.push('入站失败日志读取已截断，最近 24 小时计数是下限。')
  if (ingressFailures.invalidLines > 0) warnings.push(`入站失败日志有 ${ingressFailures.invalidLines} 条无效记录，已跳过。`)
  if (ingressFailures.count > 0) warnings.push(`最近 24 小时有 ${ingressFailures.count} 次入站事实最终持久化失败。`)

  return healthSnapshotSchema.parse({
    schemaVersion: 3,
    generatedAt: now.toISOString(),
    process: processStatus,
    database,
    ledger,
    deepLedgerCheck: lastDeepLedgerCheck,
    knowledge: {
      ok: knowledge.ok,
      counts: knowledge.counts,
      lifecycle: knowledge.lifecycle,
      issueCount: knowledgeIssueCount,
      agendaExists: knowledge.agenda.exists,
    },
    contextSurface: { status: surface.status, generatedAt: surfaceGeneratedAt, ageSeconds: surfaceAgeSeconds },
    mailboxWatcher,
    ingressFailures,
    migrations: { files: migrationFiles, ...migrationRows },
    warnings,
  })
}

export async function runDeepLedgerHealthCheck(now = new Date()): Promise<HealthSnapshot['deepLedgerCheck']> {
  if (deepLedgerCheckPromise != null) return deepLedgerCheckPromise
  deepLedgerCheckPromise = (async () => {
    const startedAt = performance.now()
    const db = getAdminPrisma()
    const report = await db.$transaction(
      tx => checkAgentLedger(createPrismaAgentLedgerCheckSource(tx as never)),
      { isolationLevel: 'RepeatableRead', timeout: 60_000 },
    )
    lastDeepLedgerCheck = {
      checkedAt: now.toISOString(),
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      ...report,
    }
    return lastDeepLedgerCheck
  })().finally(() => { deepLedgerCheckPromise = null })
  return deepLedgerCheckPromise
}

async function loadQuickLedgerHealth(
  db: ReturnType<typeof getAdminPrisma>,
): Promise<HealthSnapshot['ledger']> {
  try {
    return await db.$transaction(async tx => {
      const [runtime, checkpoint, permanentEntryCount, latestEntry, latestCompaction] = await Promise.all([
        tx.botAgentRuntimeState.findUnique({ where: { id: 1 }, select: { ledgerHeadEntryId: true } }),
        tx.botAgentCheckpoint.findUnique({ where: { id: 1 }, select: { schemaVersion: true, throughEntryId: true } }),
        tx.botAgentLedgerEntry.count(),
        tx.botAgentLedgerEntry.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }),
        tx.botAgentLedgerEntry.findFirst({
          where: { entryType: 'compaction' }, orderBy: { id: 'desc' }, select: { id: true },
        }),
      ])
      const headEntryId = runtime?.ledgerHeadEntryId?.toString() ?? null
      const checkpointStatus = checkpoint == null
        ? 'missing' as const
        : checkpoint.schemaVersion !== AGENT_CHECKPOINT_SCHEMA_VERSION
            ? 'corrupt' as const
            : checkpoint.throughEntryId === runtime?.ledgerHeadEntryId
                ? 'hit' as const
                : 'stale' as const
      return {
        ok: runtime != null && headEntryId === (latestEntry?.id.toString() ?? null),
        headEntryId,
        latestCompactionEntryId: latestCompaction?.id.toString() ?? null,
        permanentEntryCount,
        checkpointStatus,
      }
    }, { isolationLevel: 'RepeatableRead' })
  } catch {
    return {
      ok: false, headEntryId: null, latestCompactionEntryId: null,
      permanentEntryCount: 0, checkpointStatus: 'corrupt',
    }
  }
}

async function readMailboxWatcherStatus(path: string): Promise<HealthSnapshot['mailboxWatcher']> {
  try {
    const parsed = mailboxWatcherStatusSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    if (!parsed.success) {
      return {
        status: 'invalid', cursor: null, blockedAtRowId: null, consecutiveFailures: 0,
        lastErrorKind: null, lastFailedAt: null,
      }
    }
    return {
      status: 'available',
      cursor: parsed.data.cursor,
      blockedAtRowId: parsed.data.blockedAtRowId,
      consecutiveFailures: parsed.data.consecutiveFailures,
      lastErrorKind: parsed.data.lastErrorKind,
      lastFailedAt: parsed.data.lastFailedAt,
    }
  } catch (error) {
    return {
      status: error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT'
        ? 'missing'
        : 'invalid',
      cursor: null,
      blockedAtRowId: null,
      consecutiveFailures: 0,
      lastErrorKind: null,
      lastFailedAt: null,
    }
  }
}

async function checkDatabase(db: ReturnType<typeof getAdminPrisma>): Promise<{ ok: boolean; error: string | null }> {
  try {
    await db.$queryRawUnsafe('SELECT 1 AS ok')
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: safeError(error) }
  }
}

async function inspectBotProcess(path: string): Promise<HealthSnapshot['process']> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { pidFilePresent: false, pid: null, reachable: false, label: 'PID 文件不存在' }
  }
  const pid = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) {
    return { pidFilePresent: true, pid: null, reachable: false, label: 'PID 文件无效' }
  }
  try {
    process.kill(pid, 0)
    return { pidFilePresent: true, pid, reachable: true, label: 'PID 可达（诊断提示）' }
  } catch {
    return { pidFilePresent: true, pid, reachable: false, label: 'PID 不可达' }
  }
}

async function countMigrationFiles(path: string): Promise<number> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).length
  } catch {
    return 0
  }
}

async function readMigrationRows(db: ReturnType<typeof getAdminPrisma>): Promise<{ applied: number; failed: number }> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ applied: bigint | number; failed: bigint | number }>>(
      'SELECT COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied, COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS failed FROM "_prisma_migrations"',
    )
    const row = rows[0]
    return { applied: Number(row?.applied ?? 0), failed: Number(row?.failed ?? 0) }
  } catch {
    return { applied: 0, failed: 0 }
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : 'unknown error'
}
