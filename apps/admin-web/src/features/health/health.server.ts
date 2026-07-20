import '@tanstack/react-start/server-only'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { checkAgentLedger, createPrismaAgentLedgerCheckSource } from '../../../../../src/ops/agent-ledger-check.js'
import { checkAgentMemory } from '../../../../../src/ops/agent-memory-check.js'
import { AGENT_CONTEXT_SURFACE_PATH, readAgentContextSurface } from '../../../../../src/ops/agent-context-surface.js'
import { getAdminPrisma } from '../../server/db.server.js'
import { getRepositoryRoot, getWorkspaceRoot } from '../../server/paths.server.js'
import { healthSnapshotSchema, type HealthSnapshot } from './health.schema.js'

export async function loadHealthSnapshot(now = new Date()): Promise<HealthSnapshot> {
  const db = getAdminPrisma()
  const root = getRepositoryRoot()
  const [database, ledger, knowledge, processStatus, surface, migrationFiles, migrationRows] = await Promise.all([
    checkDatabase(db),
    checkAgentLedger(createPrismaAgentLedgerCheckSource(db as never)),
    checkAgentMemory({ rootDir: getWorkspaceRoot(), now }),
    inspectBotProcess(join(root, '.bot.pid')),
    readAgentContextSurface(join(root, AGENT_CONTEXT_SURFACE_PATH)),
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
  if (!ledger.ok) warnings.push('Canonical ledger 完整性检查失败。')
  if (!knowledge.ok) warnings.push('长期状态结构检查失败。')
  if (migrationRows.failed > 0) warnings.push('存在失败的 Prisma migration。')
  if (surface.status !== 'available') warnings.push(`Context surface ${surface.status}。`)

  return healthSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    process: processStatus,
    database,
    ledger,
    knowledge: {
      ok: knowledge.ok,
      counts: knowledge.counts,
      lifecycle: knowledge.lifecycle,
      issueCount: knowledgeIssueCount,
      agendaExists: knowledge.agenda.exists,
    },
    contextSurface: { status: surface.status, generatedAt: surfaceGeneratedAt, ageSeconds: surfaceAgeSeconds },
    migrations: { files: migrationFiles, ...migrationRows },
    warnings,
  })
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
