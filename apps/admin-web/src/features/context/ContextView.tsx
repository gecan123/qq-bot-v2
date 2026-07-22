import { JsonBlock, PageHeader, Panel, StatCard, StatGrid, StatusBadge, WarningList } from '../../components/AdminUi.js'
import { formatCount, formatPercent, formatTimestamp } from '../../lib/format.js'
import type { ContextSnapshot } from './context.schema.js'

export function ContextView({ snapshot, isRefreshing, refreshFailed }: { snapshot: ContextSnapshot; isRefreshing: boolean; refreshFailed: boolean }) {
  const usage = snapshot.latestUsage
  return <>
    <PageHeader title="Context / Ledger 工作台" description="从 canonical append-only ledger 观察当前投影边界、entry 构成和最近历史；Checkpoint 仅是可重建缓存。" generatedAt={snapshot.generatedAt} isRefreshing={isRefreshing} refreshFailed={refreshFailed} />
    <StatGrid>
      <StatCard label="Canonical entries" value={formatCount(snapshot.ledger.total)} detail={`Head #${snapshot.ledger.headId ?? '—'}`} />
      <StatCard label="Checkpoint through" value={snapshot.ledger.checkpointThroughId ? `#${snapshot.ledger.checkpointThroughId}` : '无'} detail={formatTimestamp(snapshot.ledger.checkpointUpdatedAt)} tone="info" />
      <StatCard label="Latest input" value={formatCount(usage?.inputTokens ?? null)} detail={usage?.model ?? '暂无 agent.chat usage'} />
      <StatCard label="Cache hit" value={formatPercent(usage?.cacheHitRate ?? null)} detail={`${formatCount(usage?.cachedTokens ?? null)} cached`} />
    </StatGrid>
    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      <Panel title="最近 80 条 canonical entries" description="按 id 倒序；长文本和二进制字段已截断。">
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-xs text-stone-500"><th className="p-2">ID / 时间</th><th className="p-2">类型</th><th className="p-2">安全预览</th></tr></thead><tbody>
          {snapshot.entries.map(entry => <tr key={entry.id} className="border-b border-stone-100 align-top"><td className="whitespace-nowrap p-2 font-mono text-xs">#{entry.id}<br/><span className="text-stone-500">{formatTimestamp(entry.createdAt)}</span></td><td className="p-2"><StatusBadge tone={entry.entryType === 'compaction' ? 'warn' : 'neutral'}>{entry.entryType}</StatusBadge>{entry.role && <div className="mt-1 text-xs text-stone-500">{entry.role}</div>}</td><td className="max-w-3xl p-2"><JsonBlock value={entry.preview} variant="preview" /></td></tr>)}
        </tbody></table></div>
      </Panel>
      <div className="space-y-4">
        <Panel title="Entry 构成">{snapshot.ledger.typeCounts.map(item => <div key={item.type} className="mb-2 flex items-center justify-between gap-3 rounded-lg bg-stone-100 px-3 py-2 text-sm"><span>{item.type}</span><strong>{formatCount(item.count)}</strong></div>)}</Panel>
        <Panel title="Runtime projection 指针"><dl className="space-y-2 text-sm"><Metric label="Runtime head" value={snapshot.runtime.ledgerHeadId ?? '—'} /><Metric label="Goal revision" value={String(snapshot.runtime.goalRevision ?? '—')} /><Metric label="Runtime updated" value={formatTimestamp(snapshot.runtime.updatedAt)} /></dl></Panel>
      </div>
    </div>
    <WarningList warnings={snapshot.warnings} />
  </>
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3"><dt className="text-stone-500">{label}</dt><dd className="m-0 break-all text-right font-medium">{value}</dd></div> }
