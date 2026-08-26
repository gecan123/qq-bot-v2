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
    <PageHeader title="执行追踪" description="把模型用量、工具执行与 Ledger 写入按时间排列，用于定位系统实际执行到哪一步。" generatedAt={snapshot.generatedAt} isRefreshing={isRefreshing} refreshFailed={refreshFailed}/>
    <aside className="surface-definition" aria-label="执行追踪说明">
      <strong>这是运行诊断，不是 Agent 记忆</strong>
      <span>页面将正式 Ledger 与额外观测放在一起；工具与 Token 观测不会成为 Agent 后续上下文。</span>
      <a href="/context">查看 Agent 历史</a>
    </aside>
    <StatGrid><StatCard label="Ledger 记录" value={snapshot.summary.ledger}/><StatCard label="工具执行" value={snapshot.summary.tools} detail={`${snapshot.summary.failedTools} 失败`} tone={snapshot.summary.failedTools ? 'warn' : 'good'}/><StatCard label="副作用" value={snapshot.summary.sideEffects} tone={snapshot.summary.sideEffects ? 'warn' : 'neutral'}/><StatCard label="模型用量" value={snapshot.summary.tokenEvents}/></StatGrid>
    <details className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
      <summary className="cursor-pointer font-semibold">关联限制</summary>
      <p className="mb-0 mt-2">{snapshot.warning}</p>
    </details>
    <div className="filter-toolbar mt-4"><SearchInput value={search} onChange={setSearch} label="搜索追踪记录" placeholder="搜索标题、内容或关联标记"/><select aria-label="记录类型" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="all">全部记录</option><option value="ledger">Ledger</option><option value="tool">工具</option><option value="token">Token</option></select><span className="filter-count">{events.length} / {snapshot.events.length} 条记录</span></div>
    <Panel className="mt-4" title="最近执行记录" description="按发生时间倒序；每条是独立观测，不代表 Agent 记忆中的一个完整回合。">{events.length ? <ol className="m-0 list-none p-0">{events.map(event => <li key={event.key} className="grid gap-2 border-l-2 border-stone-300 py-3 pl-4 md:grid-cols-[170px_130px_minmax(0,1fr)]"><time className="text-xs text-stone-500">{formatTimestamp(event.at)}</time><div className="flex flex-wrap items-start gap-1"><StatusBadge tone={event.kind === 'tool' ? event.ok ? 'good' : 'bad' : event.kind === 'token' ? 'info' : 'neutral'}>{event.kind}</StatusBadge>{event.sideEffect && <StatusBadge tone="warn">side effect</StatusBadge>}</div><div><p className="m-0 text-sm font-semibold">{event.title}</p><p className="mb-0 mt-1 break-all font-mono text-xs leading-5 text-stone-600">{event.detail}</p>{event.jsonDetail && <div className="mt-2"><JsonBlock value={event.jsonDetail} variant="preview" /></div>}<p className="mb-0 mt-1 text-[11px] text-stone-400">{event.correlation}{event.roundIndex === null ? '' : ` · round ${event.roundIndex}`}</p></div></li>)}</ol> : <EmptyState>没有匹配的追踪记录</EmptyState>}</Panel>
  </>
}
