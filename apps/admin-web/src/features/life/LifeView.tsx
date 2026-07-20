import { EmptyState, JsonBlock, PageHeader, Panel, StatCard, StatGrid, StatusBadge } from '../../components/AdminUi.js'
import { formatCount, formatDuration, formatTimestamp } from '../../lib/format.js'
import type { LifeSnapshot } from './life.schema.js'

export function LifeView({ snapshot, isRefreshing, refreshFailed }: { snapshot: LifeSnapshot; isRefreshing: boolean; refreshFailed: boolean }) {
  const goal = snapshot.goal
  const activeTasks = snapshot.backgroundTasks.filter(task => task.status === 'running' || task.status === 'pending').length
  return <>
    <PageHeader title="生命状态" description="Goal 是持久控制状态；Agenda、Schedule 与 Background Task 按各自真实存储读取，临时 todo 明确不持久。" generatedAt={snapshot.generatedAt} isRefreshing={isRefreshing} refreshFailed={refreshFailed}/>
    <StatGrid>
      <StatCard label="Current goal" value={goal?.status ?? '无'} detail={goal?.objective ?? '暂无持久 Goal'} tone={goal ? 'info' : 'neutral'} />
      <StatCard label="Goal usage" value={`${formatCount(goal?.tokensUsed ?? 0)} tokens`} detail={`${goal?.roundsUsed ?? 0} rounds · ${formatDuration((goal?.timeUsedSeconds ?? 0) * 1000)}`} />
      <StatCard label="Schedules" value={String(snapshot.schedules.length)} detail="持久计划" />
      <StatCard label="Background active" value={String(activeTasks)} detail={`${snapshot.backgroundTasks.length} 条最近记录`} tone={activeTasks ? 'warn' : 'good'} />
    </StatGrid>
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
      <Panel title="当前 Goal" description={goal ? `origin=${goal.origin} · revision=${goal.revision}` : undefined}>{goal ? <div className="space-y-3 text-sm"><p className="m-0 text-lg font-semibold">{goal.objective}</p>{goal.motivation && <p className="m-0 text-stone-600">{goal.motivation}</p>}<div className="flex flex-wrap gap-2"><StatusBadge tone={goal.status === 'active' ? 'good' : goal.status === 'blocked' ? 'bad' : 'neutral'}>{goal.status}</StatusBadge>{goal.tokenBudget && <StatusBadge>{goal.tokensUsed}/{goal.tokenBudget} tokens</StatusBadge>}{goal.blockerKey && <StatusBadge tone="bad">{goal.blockerKey} × {goal.blockerTurns}</StatusBadge>}</div>{goal.blockedReason && <p className="rounded-lg bg-red-50 p-3 text-red-800">{goal.blockedReason}</p>}<div className="grid gap-3 md:grid-cols-2"><div><h3 className="text-sm">当前承诺</h3><JsonBlock value={goal.currentCommitment}/></div><div><h3 className="text-sm">完成条件 / 证据</h3><JsonBlock value={{ criteria: goal.completionCriteria, evidence: goal.completionEvidence }}/></div></div></div> : <EmptyState>暂无持久 Goal</EmptyState>}</Panel>
      <Panel title="Runtime control state"><dl className="grid grid-cols-2 gap-3 text-sm"><Metric label="Last wake" value={formatTimestamp(snapshot.runtime.lastWakeAt)}/><Metric label="Updated" value={formatTimestamp(snapshot.runtime.updatedAt)}/><Metric label="Mailboxes" value={String(snapshot.runtime.mailboxCount)}/><Metric label="Inbox read cursors" value={String(snapshot.runtime.inboxReadCount)}/><Metric label="Capabilities" value={String(snapshot.runtime.capabilities.length)}/></dl><div className="mt-3"><JsonBlock value={{ focus: snapshot.runtime.focus, capabilities: snapshot.runtime.capabilities }}/></div></Panel>
      <Panel title="Life Agenda" description="直接读取 Markdown；不会因查看页面而创建或改写文件。">{snapshot.agenda.exists ? <><div className="mb-3 flex flex-wrap gap-2">{Object.entries(snapshot.agenda.sections).map(([name, count]) => <StatusBadge key={name}>{name} {count}</StatusBadge>)}</div><pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg bg-stone-100 p-3 text-sm leading-6">{snapshot.agenda.markdown}</pre></> : <EmptyState>Agenda 文件不存在</EmptyState>}</Panel>
      <Panel title="Schedule / Background Task"><h3 className="mt-0 text-sm">Schedules</h3>{snapshot.schedules.length ? snapshot.schedules.map(item => <Row key={item.id} title={item.label} meta={`${item.status} · ${item.nextRunAt ?? '—'}`}/>) : <EmptyState>暂无 schedule</EmptyState>}<h3 className="mt-5 text-sm">最近后台任务</h3><div className="max-h-[480px] overflow-auto">{snapshot.backgroundTasks.map(item => <Row key={item.id} title={item.description || item.toolName} meta={`${item.toolName} · ${item.status} · attempt ${item.attempt} · ${formatTimestamp(item.updatedAt)}`} detail={item.summary}/>)}</div></Panel>
    </div>
    <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950"><ul className="m-0 list-disc space-y-1 pl-5">{snapshot.notes.map(note => <li key={note}>{note}</li>)}</ul></div>
  </>
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-lg bg-stone-100 p-3"><dt className="text-xs text-stone-500">{label}</dt><dd className="m-0 mt-1 font-medium">{value}</dd></div> }
function Row({ title, meta, detail }: { title: string; meta: string; detail?: string | null }) { return <div className="border-b border-stone-100 py-3 last:border-0"><p className="m-0 text-sm font-medium">{title}</p><p className="mb-0 mt-1 text-xs text-stone-500">{meta}</p>{detail && <p className="mb-0 mt-1 text-xs text-stone-600">{detail}</p>}</div> }
