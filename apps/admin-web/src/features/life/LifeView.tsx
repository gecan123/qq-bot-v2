import { EmptyState, JsonBlock, PageHeader, Panel, StatCard, StatGrid } from '../../components/AdminUi.js'
import { formatTimestamp } from '../../lib/format.js'
import type { LifeSnapshot } from './life.schema.js'

export function LifeView({ snapshot, isRefreshing, refreshFailed }: { snapshot: LifeSnapshot; isRefreshing: boolean; refreshFailed: boolean }) {
  const activeTasks = snapshot.backgroundTasks.filter(task => task.status === 'running' || task.status === 'pending').length
  return <>
    <PageHeader title="计划" description="Schedule 与 Background Task 按各自真实存储读取。" generatedAt={snapshot.generatedAt} isRefreshing={isRefreshing} refreshFailed={refreshFailed}/>
    <StatGrid>
      <StatCard label="Schedules" value={String(snapshot.schedules.length)} detail="持久计划" />
      <StatCard label="Background active" value={String(activeTasks)} detail={`${snapshot.backgroundTasks.length} 条最近记录`} tone={activeTasks ? 'warn' : 'good'} />
    </StatGrid>
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
      <Panel title="Runtime control state"><dl className="grid grid-cols-2 gap-3 text-sm"><Metric label="Last wake" value={formatTimestamp(snapshot.runtime.lastWakeAt)}/><Metric label="Updated" value={formatTimestamp(snapshot.runtime.updatedAt)}/><Metric label="Mailboxes" value={String(snapshot.runtime.mailboxCount)}/><Metric label="Inbox read cursors" value={String(snapshot.runtime.inboxReadCount)}/></dl><div className="mt-3"><JsonBlock value={{ focus: snapshot.runtime.focus }}/></div></Panel>
      <Panel title="Schedule / Background Task"><h3 className="mt-0 text-sm">Schedules</h3>{snapshot.schedules.length ? snapshot.schedules.map(item => <Row key={item.id} title={item.label} meta={`${item.status} · ${item.nextRunAt ?? '—'}`}/>) : <EmptyState>暂无 schedule</EmptyState>}<h3 className="mt-5 text-sm">最近后台任务</h3><div className="max-h-[480px] overflow-auto">{snapshot.backgroundTasks.map(item => <Row key={item.id} title={item.description || item.toolName} meta={`${item.toolName} · ${item.status} · attempt ${item.attempt} · ${formatTimestamp(item.updatedAt)}`} detail={item.summary}/>)}</div></Panel>
    </div>
    <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950"><ul className="m-0 list-disc space-y-1 pl-5">{snapshot.notes.map(note => <li key={note}>{note}</li>)}</ul></div>
  </>
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-lg bg-stone-100 p-3"><dt className="text-xs text-stone-500">{label}</dt><dd className="m-0 mt-1 font-medium">{value}</dd></div> }
function Row({ title, meta, detail }: { title: string; meta: string; detail?: string | null }) { return <div className="border-b border-stone-100 py-3 last:border-0"><p className="m-0 text-sm font-medium">{title}</p><p className="mb-0 mt-1 text-xs text-stone-500">{meta}</p>{detail && <p className="mb-0 mt-1 text-xs text-stone-600">{detail}</p>}</div> }
