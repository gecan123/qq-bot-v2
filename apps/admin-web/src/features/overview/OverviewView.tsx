import type { OverviewSnapshot } from './overview.schema.js'

type OverviewViewProps = {
  snapshot: OverviewSnapshot
  isRefreshing: boolean
  refreshFailed: boolean
}

export function OverviewView({ snapshot, isRefreshing, refreshFailed }: OverviewViewProps) {
  const usage = snapshot.latestAgentUsage

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 border-b border-stone-300 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-stone-900">QQ Bot WebAdmin</h1>
            <span className="rounded-full border border-emerald-700/30 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
              只读模式
            </span>
          </div>
          <p className="m-0 text-sm text-stone-600">更新于 {formatTimestamp(snapshot.generatedAt)}</p>
        </div>
        <div className="text-sm font-medium" aria-live="polite">
          {refreshFailed ? (
            <span className="text-red-700">刷新失败，显示上一帧</span>
          ) : isRefreshing ? (
            <span className="text-amber-700">刷新中</span>
          ) : (
            <span className="text-stone-500">自动刷新 · 5 秒</span>
          )}
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="运行总览">
        <OverviewCard label="Ledger entries" value={String(snapshot.ledger.entryCount)} detail={snapshot.ledger.latestEntryType ?? '暂无 entry'} />
        <OverviewCard
          label="Ledger head"
          value={snapshot.ledger.headEntryId === null ? '暂无 head' : `Head #${snapshot.ledger.headEntryId}`}
          detail={snapshot.ledger.latestEntryAt === null ? '暂无更新时间' : formatTimestamp(snapshot.ledger.latestEntryAt)}
        />
        <OverviewCard
          label="Runtime / focus"
          value={formatRuntime(snapshot)}
          detail={snapshot.runtime.lastWakeAt === null ? '暂无 wake' : `Wake ${formatTimestamp(snapshot.runtime.lastWakeAt)}`}
          warning={!snapshot.runtime.available}
        />
        <OverviewCard
          label="Goal"
          value={snapshot.goal?.objective ?? '暂无活跃 Goal'}
          detail={snapshot.goal?.status ?? '—'}
        />
        <OverviewCard
          label="Latest agent token"
          value={usage === null ? '暂无数据' : `${formatCount(usage.inputTokens)} in · ${formatCount(usage.outputTokens)} out`}
          detail={usage?.model ?? '—'}
        />
        <OverviewCard
          label="Cache hit"
          value={usage?.cacheHitRate == null ? '暂无数据' : `${(usage.cacheHitRate * 100).toFixed(1)}%`}
          detail={usage === null ? '—' : `${formatCount(usage.cachedTokens)} cached tokens`}
        />
        <OverviewCard label="Tools 24h" value={String(snapshot.tools24h.calls)} detail="calls" />
        <OverviewCard
          label="Tool failures"
          value={`${snapshot.tools24h.failed} / ${snapshot.tools24h.calls}`}
          detail="failed / total"
          warning={snapshot.tools24h.failed > 0}
        />
      </section>

      {snapshot.warnings.length > 0 && (
        <section className="mt-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950" aria-label="告警">
          <p className="m-0 font-medium">数据告警</p>
          <ul className="mb-0 mt-2 list-disc pl-5">
            {snapshot.warnings.map(warning => <li key={warning}>{warning}</li>)}
          </ul>
        </section>
      )}
    </main>
  )
}

function OverviewCard({
  label,
  value,
  detail,
  warning = false,
}: {
  label: string
  value: string
  detail: string
  warning?: boolean
}) {
  return (
    <article className="min-w-0 rounded-xl border border-stone-300 bg-white/80 p-4 shadow-sm">
      <p className="m-0 text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</p>
      <p className={`mb-0 mt-3 break-words text-xl font-semibold ${warning ? 'text-amber-800' : 'text-stone-900'}`}>{value}</p>
      <p className="mb-0 mt-2 truncate text-sm text-stone-500">{detail}</p>
    </article>
  )
}

function formatRuntime(snapshot: OverviewSnapshot): string {
  if (!snapshot.runtime.available) return 'Runtime 状态缺失'
  if (snapshot.runtime.focus === null) return '未选择会话'
  return snapshot.runtime.focus.type === 'group'
    ? `群 ${snapshot.runtime.focus.id}`
    : `私聊 ${snapshot.runtime.focus.id}`
}

function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-US')
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: false,
  }).format(new Date(value))
}
