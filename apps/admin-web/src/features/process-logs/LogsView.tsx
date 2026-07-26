import { useQuery } from '@tanstack/react-query'
import { Check, Pause, Play, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState, PageHeader, Panel, StatusBadge, WarningList } from '../../components/AdminUi.js'
import { formatCount, formatTimestamp } from '../../lib/format.js'
import {
  processLogLevelSchema,
  type ProcessLogLevel,
  type ProcessLogSnapshot,
  type ProcessLogSource,
} from './logs.js'
import { processLogsQueryOptions } from './logs.query.js'

const LEVEL_OPTIONS: Array<'all' | ProcessLogLevel> = ['all', ...processLogLevelSchema.options]

export function LogsView({ initialSnapshot }: { initialSnapshot: ProcessLogSnapshot }) {
  const [source, setSource] = useState<ProcessLogSource>(initialSnapshot.selectedSource)
  const [level, setLevel] = useState<'all' | ProcessLogLevel>('all')
  const [search, setSearch] = useState('')
  const [live, setLive] = useState(true)
  const [follow, setFollow] = useState(true)
  const viewportRef = useRef<HTMLDivElement>(null)
  const query = useQuery({
    ...processLogsQueryOptions(source),
    refetchInterval: live ? 2_000 : false,
    refetchIntervalInBackground: false,
    ...(source === initialSnapshot.selectedSource ? { initialData: initialSnapshot } : {}),
  })
  const snapshot = query.data?.selectedSource === source ? query.data : null
  const sources = snapshot?.sources ?? initialSnapshot.sources
  const entries = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    return (snapshot?.entries ?? []).filter(entry => (
      (level === 'all' || entry.level === level)
      && (!normalizedSearch || entry.text.toLocaleLowerCase().includes(normalizedSearch))
    ))
  }, [level, search, snapshot?.entries])

  useEffect(() => {
    if (!follow || !viewportRef.current) return
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight
  }, [entries.length, follow, snapshot?.generatedAt])

  return (
    <>
      <PageHeader
        title="进程日志"
        description="只读查看平台托管进程的有界日志尾部；日志是观察数据，不参与 Agent replay。"
        generatedAt={snapshot?.generatedAt ?? initialSnapshot.generatedAt}
        isRefreshing={query.isFetching}
        refreshFailed={query.isError}
      />

      <div className="log-source-grid">
        {sources.map(item => (
          <button
            key={item.id}
            type="button"
            className={`log-source-card ${source === item.id ? 'log-source-card--active' : ''}`}
            onClick={() => setSource(item.id)}
          >
            <span className={`log-source-status ${item.exists ? 'log-source-status--ready' : ''}`} />
            <span>
              <strong>{item.label}</strong>
              <small>{item.exists ? `${formatCount(item.sizeBytes)} bytes · ${formatTimestamp(item.updatedAt)}` : '尚无日志'}</small>
            </span>
            {source === item.id && <Check size={14} />}
          </button>
        ))}
      </div>

      <Panel
        className="mt-4"
        title={sources.find(item => item.id === source)?.label ?? source}
        description="最多读取文件尾部 512 KiB，并返回最后 500 行。"
      >
        <div className="log-toolbar">
          <label className="log-search">
            <Search size={14} />
            <input
              aria-label="搜索当前日志"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="搜索当前日志"
            />
          </label>
          <select
            aria-label="日志级别"
            value={level}
            onChange={event => setLevel(event.target.value as 'all' | ProcessLogLevel)}
          >
            {LEVEL_OPTIONS.map(option => <option key={option} value={option}>{option === 'all' ? '全部级别' : option.toUpperCase()}</option>)}
          </select>
          <button type="button" className="log-toggle" onClick={() => setLive(value => !value)}>
            {live ? <Pause size={13} /> : <Play size={13} />}
            {live ? '暂停刷新' : '继续刷新'}
          </button>
          <button type="button" className="log-toggle" onClick={() => void query.refetch()}>
            <RefreshCw size={13} />
            立即刷新
          </button>
          <label className="log-follow">
            <input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />
            跟随最新
          </label>
        </div>

        {!snapshot || query.isPending ? (
          <EmptyState>正在读取 {source} 日志…</EmptyState>
        ) : entries.length === 0 ? (
          <EmptyState>{snapshot.entries.length === 0 ? '当前进程还没有日志。' : '没有匹配当前筛选条件的日志。'}</EmptyState>
        ) : (
          <div ref={viewportRef} className="log-viewport" role="log" aria-live="off">
            {entries.map(entry => (
              <div key={`${entry.sequence}-${entry.text}`} className={`log-line log-line--${entry.level}`}>
                <span className="log-line-number">{entry.sequence}</span>
                <StatusBadge tone={levelTone(entry.level)}>{entry.level}</StatusBadge>
                <code>{entry.text}</code>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <WarningList warnings={snapshot?.warnings ?? []} />
    </>
  )
}

function levelTone(level: ProcessLogLevel): 'neutral' | 'good' | 'warn' | 'bad' | 'info' {
  if (level === 'fatal' || level === 'error') return 'bad'
  if (level === 'warn') return 'warn'
  if (level === 'info') return 'good'
  if (level === 'debug' || level === 'trace') return 'info'
  return 'neutral'
}
