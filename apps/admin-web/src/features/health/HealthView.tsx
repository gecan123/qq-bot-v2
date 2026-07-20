import { EmptyState, JsonBlock, PageHeader, Panel, StatCard, StatGrid, StatusBadge, WarningList } from '../../components/AdminUi.js'
import { formatCount, formatTimestamp } from '../../lib/format.js'
import type { HealthSnapshot } from './health.schema.js'

export function HealthView({ snapshot, isRefreshing, refreshFailed }: { snapshot: HealthSnapshot; isRefreshing: boolean; refreshFailed: boolean }) {
  return (
    <>
      <PageHeader title="系统健康" description="区分进程提示、数据库事实、canonical 完整性与可丢弃缓存；PID 可达不等于主循环已进入稳定运行。" generatedAt={snapshot.generatedAt} isRefreshing={isRefreshing} refreshFailed={refreshFailed} />
      <StatGrid>
        <StatCard label="Bot process" value={snapshot.process.reachable ? 'PID 可达' : '不可达'} detail={snapshot.process.label} tone={snapshot.process.reachable ? 'good' : 'bad'} />
        <StatCard label="PostgreSQL" value={snapshot.database.ok ? '只读探针正常' : '探针失败'} detail={snapshot.database.error ?? 'SELECT 1'} tone={snapshot.database.ok ? 'good' : 'bad'} />
        <StatCard label="Canonical ledger" value={snapshot.ledger.ok ? '完整' : '异常'} detail={`Head ${snapshot.ledger.headEntryId ?? '—'} · ${formatCount(snapshot.ledger.activeEntryCount)} active`} tone={snapshot.ledger.ok ? 'good' : 'bad'} />
        <StatCard label="Checkpoint" value={snapshot.ledger.checkpointStatus} detail="仅为可重建 projection cache" tone={snapshot.ledger.checkpointStatus === 'hit' ? 'good' : 'warn'} />
      </StatGrid>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Panel title="Ledger 与 Context" description="完整性检查直接读取 canonical rows；不从日志或 side-data 重建 transcript。">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Metric label="Permanent entries" value={formatCount(snapshot.ledger.permanentEntryCount)} />
            <Metric label="Projection tokens" value={formatCount(snapshot.ledger.projectionTokens)} />
            <Metric label="Latest compaction" value={snapshot.ledger.latestCompactionEntryId ?? '无'} />
            <Metric label="Context surface" value={snapshot.contextSurface.status} />
            <Metric label="Surface generated" value={formatTimestamp(snapshot.contextSurface.generatedAt)} />
            <Metric label="Surface age" value={snapshot.contextSurface.ageSeconds === null ? '—' : `${snapshot.contextSurface.ageSeconds}s`} />
          </dl>
          {snapshot.ledger.errors.length > 0 && <div className="mt-4"><JsonBlock value={snapshot.ledger.errors} /></div>}
        </Panel>
        <Panel title="长期状态与迁移">
          <div className="mb-4 flex flex-wrap gap-2">
            <StatusBadge tone={snapshot.knowledge.ok ? 'good' : 'bad'}>Knowledge {snapshot.knowledge.ok ? 'OK' : '异常'}</StatusBadge>
            <StatusBadge tone={snapshot.migrations.failed === 0 ? 'good' : 'bad'}>Migration failed {snapshot.migrations.failed}</StatusBadge>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Metric label="Memory" value={`${snapshot.knowledge.counts.memory.entries} entries`} />
            <Metric label="Notebook" value={`${snapshot.knowledge.counts.notebook.entries} entries`} />
            <Metric label="Life Journal" value={`${snapshot.knowledge.counts.lifeJournal.entries} entries`} />
            <Metric label="Knowledge issues" value={String(snapshot.knowledge.issueCount)} />
            <Metric label="Migration files" value={String(snapshot.migrations.files)} />
            <Metric label="Applied migrations" value={String(snapshot.migrations.applied)} />
          </dl>
          {!snapshot.knowledge.agendaExists && <div className="mt-4"><EmptyState>Agenda 尚不存在；健康检查不会创建默认文件。</EmptyState></div>}
        </Panel>
      </div>
      <WarningList warnings={snapshot.warnings} />
    </>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-stone-100 px-3 py-2"><dt className="text-xs text-stone-500">{label}</dt><dd className="m-0 mt-1 break-words font-medium text-stone-900">{value}</dd></div>
}
