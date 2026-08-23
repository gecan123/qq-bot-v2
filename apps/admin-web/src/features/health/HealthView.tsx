import { EmptyState, JsonBlock, PageHeader, Panel, StatCard, StatGrid, StatusBadge, WarningList } from '../../components/AdminUi.js'
import { formatCount, formatTimestamp } from '../../lib/format.js'
import type { HealthSnapshot } from './health.schema.js'

export function HealthView({ snapshot, isRefreshing, refreshFailed, isDeepChecking, onDeepCheck }: { snapshot: HealthSnapshot; isRefreshing: boolean; refreshFailed: boolean; isDeepChecking: boolean; onDeepCheck(): void }) {
  const deep = snapshot.deepLedgerCheck
  return (
    <>
      <PageHeader title="系统健康" description="区分进程提示、数据库事实、canonical 完整性与可丢弃缓存；PID 可达不等于主循环已进入稳定运行。" generatedAt={snapshot.generatedAt} isRefreshing={isRefreshing} refreshFailed={refreshFailed} />
      <StatGrid>
        <StatCard label="Bot process" value={snapshot.process.reachable ? 'PID 可达' : '不可达'} detail={snapshot.process.label} tone={snapshot.process.reachable ? 'good' : 'bad'} />
        <StatCard label="PostgreSQL" value={snapshot.database.ok ? '只读探针正常' : '探针失败'} detail={snapshot.database.error ?? 'SELECT 1'} tone={snapshot.database.ok ? 'good' : 'bad'} />
        <StatCard label="Ledger quick check" value={snapshot.ledger.ok ? '正常' : '异常'} detail={`Head ${snapshot.ledger.headEntryId ?? '—'} · ${formatCount(snapshot.ledger.permanentEntryCount)} entries`} tone={snapshot.ledger.ok ? 'good' : 'bad'} />
        <StatCard label="Checkpoint" value={snapshot.ledger.checkpointStatus} detail="仅为可重建 projection cache" tone={snapshot.ledger.checkpointStatus === 'hit' ? 'good' : 'warn'} />
        <StatCard
          label="Mailbox watcher"
          value={snapshot.mailboxWatcher.blockedAtRowId === null ? snapshot.mailboxWatcher.status : '已阻塞'}
          detail={snapshot.mailboxWatcher.blockedAtRowId === null
            ? `Cursor ${snapshot.mailboxWatcher.cursor ?? '—'}`
            : `Row ${snapshot.mailboxWatcher.blockedAtRowId} · ${snapshot.mailboxWatcher.consecutiveFailures} 次 · ${snapshot.mailboxWatcher.lastErrorKind ?? 'unknown'}`}
          tone={snapshot.mailboxWatcher.blockedAtRowId !== null || snapshot.mailboxWatcher.status === 'invalid'
            ? 'bad'
            : snapshot.mailboxWatcher.status === 'missing'
              ? 'neutral'
              : 'good'}
        />
        <StatCard
          label="Ingress failures (24h)"
          value={snapshot.ingressFailures.status === 'available' ? String(snapshot.ingressFailures.count) : snapshot.ingressFailures.status}
          detail={snapshot.ingressFailures.status === 'missing'
            ? '日志尚不存在'
            : snapshot.ingressFailures.status === 'invalid'
              ? '日志无法读取'
              : snapshot.ingressFailures.lastFailedAt == null
                ? '无最终失败'
                : `${formatTimestamp(snapshot.ingressFailures.lastFailedAt)} · ${snapshot.ingressFailures.lastErrorKind ?? 'unknown'}${snapshot.ingressFailures.truncated ? ' · truncated' : ''}`}
          tone={snapshot.ingressFailures.status === 'invalid' || snapshot.ingressFailures.count > 0 ? 'bad' : snapshot.ingressFailures.status === 'missing' ? 'neutral' : 'good'}
        />
      </StatGrid>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Panel title="Ledger 与 Context" description="页面刷新只读取 head、计数与 checkpoint 元数据；完整 canonical replay 仅在手动深度检查时执行。">
          <button className="mb-4 rounded-md bg-stone-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={isDeepChecking} onClick={onDeepCheck} type="button">
            {isDeepChecking ? '正在深度检查…' : '运行深度完整性检查'}
          </button>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Metric label="Permanent entries" value={formatCount(snapshot.ledger.permanentEntryCount)} />
            <Metric label="Deep check" value={deep == null ? '尚未运行' : deep.ok ? '通过' : '失败'} />
            <Metric label="Deep checked at" value={formatTimestamp(deep?.checkedAt ?? null)} />
            <Metric label="Deep duration" value={deep == null ? '—' : `${deep.durationMs}ms`} />
            <Metric label="Active entries" value={deep == null ? '—' : formatCount(deep.activeEntryCount)} />
            <Metric label="Projection tokens" value={deep == null ? '—' : formatCount(deep.projectionTokens)} />
            <Metric label="Latest compaction" value={snapshot.ledger.latestCompactionEntryId ?? '无'} />
            <Metric label="Context surface" value={snapshot.contextSurface.status} />
            <Metric label="Surface generated" value={formatTimestamp(snapshot.contextSurface.generatedAt)} />
            <Metric label="Surface age" value={snapshot.contextSurface.ageSeconds === null ? '—' : `${snapshot.contextSurface.ageSeconds}s`} />
          </dl>
          {deep != null && deep.errors.length > 0 && <div className="mt-4"><JsonBlock value={deep.errors} /></div>}
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
