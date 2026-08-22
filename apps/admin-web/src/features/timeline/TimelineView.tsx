import { useMemo, useState } from 'react'
import { EmptyState, JsonBlock, PageHeader, Panel, SearchInput, StatCard, StatGrid, StatusBadge } from '../../components/AdminUi.js'
import { formatTimestamp } from '../../lib/format.js'
import type { TimelineSnapshot } from './timeline.schema.js'

export function TimelineView({ snapshot, isRefreshing, refreshFailed }: { snapshot: TimelineSnapshot; isRefreshing: boolean; refreshFailed: boolean }) {
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<'all' | TimelineSnapshot['events'][number]['kind']>('all')
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const events = useMemo(() => snapshot.events.filter(event => (
    (kind === 'all' || event.kind === kind)
    && (!normalizedSearch || [event.title, event.detail, event.correlation, event.jsonDetail].some(value => value?.toLocaleLowerCase().includes(normalizedSearch)))
  )), [kind, normalizedSearch, snapshot.events])

  return <>
    <PageHeader title="行动时间线" description="把 canonical ledger、工具观测和 token/cache 观测放到同一条只读时间轴；关联强度随标记明确展示。" generatedAt={snapshot.generatedAt} isRefreshing={isRefreshing} refreshFailed={refreshFailed}/>
    <StatGrid><StatCard label="Recent ledger" value={snapshot.summary.ledger}/><StatCard label="Tool calls" value={snapshot.summary.tools} detail={`${snapshot.summary.failedTools} failed`} tone={snapshot.summary.failedTools ? 'warn' : 'good'}/><StatCard label="Side effects" value={snapshot.summary.sideEffects} tone={snapshot.summary.sideEffects ? 'warn' : 'neutral'}/><StatCard label="Token events" value={snapshot.summary.tokenEvents}/></StatGrid>
    <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{snapshot.warning}</div>
    <div className="filter-toolbar mt-4"><SearchInput value={search} onChange={setSearch} label="搜索事件" placeholder="搜索标题、内容或关联标记"/><select aria-label="事件类型" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="all">全部事件</option><option value="ledger">Ledger</option><option value="tool">工具</option><option value="token">Token</option></select><span className="filter-count">{events.length} / {snapshot.events.length} 个事件</span></div>
    <Panel className="mt-4" title="最近事件" description="按事件时间倒序，不推断跨进程 episode。">{events.length ? <ol className="m-0 list-none p-0">{events.map(event => <li key={event.key} className="grid gap-2 border-l-2 border-stone-300 py-3 pl-4 md:grid-cols-[170px_130px_minmax(0,1fr)]"><time className="text-xs text-stone-500">{formatTimestamp(event.at)}</time><div className="flex flex-wrap items-start gap-1"><StatusBadge tone={event.kind === 'tool' ? event.ok ? 'good' : 'bad' : event.kind === 'token' ? 'info' : 'neutral'}>{event.kind}</StatusBadge>{event.sideEffect && <StatusBadge tone="warn">side effect</StatusBadge>}</div><div><p className="m-0 text-sm font-semibold">{event.title}</p><p className="mb-0 mt-1 break-all font-mono text-xs leading-5 text-stone-600">{event.detail}</p>{event.jsonDetail && <div className="mt-2"><JsonBlock value={event.jsonDetail} variant="preview" /></div>}<p className="mb-0 mt-1 text-[11px] text-stone-400">{event.correlation}{event.roundIndex === null ? '' : ` · round ${event.roundIndex}`}</p></div></li>)}</ol> : <EmptyState>没有匹配的事件</EmptyState>}</Panel>
  </>
}
