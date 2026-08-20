import { useQuery } from '@tanstack/react-query'
import { ArrowDown, Pause, Play } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState, JsonBlock, PageHeader, Panel, SearchInput, StatusBadge, WarningList } from '../../components/AdminUi.js'
import { formatCount, formatTimestamp } from '../../lib/format.js'
import {
  type ProcessLogLevel,
  type ProcessLogEntry,
  type ProcessLogSnapshot,
  type ProcessLogSource,
} from './logs.js'
import { processLogsQueryOptions } from './logs.query.js'

type LogFilter = 'all' | 'problems'
const logTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function LogsView({ initialSnapshot }: { initialSnapshot: ProcessLogSnapshot }) {
  const [source, setSource] = useState<ProcessLogSource>(initialSnapshot.selectedSource)
  const [filter, setFilter] = useState<LogFilter>('all')
  const [search, setSearch] = useState('')
  const [live, setLive] = useState(true)
  const [following, setFollowing] = useState(true)
  const viewportRef = useRef<HTMLDivElement>(null)
  const query = useQuery({
    ...processLogsQueryOptions(source),
    refetchInterval: live ? 2_000 : false,
    refetchIntervalInBackground: false,
    ...(source === initialSnapshot.selectedSource ? { initialData: initialSnapshot } : {}),
  })
  const snapshot = query.data?.selectedSource === source ? query.data : null
  const sources = snapshot?.sources ?? initialSnapshot.sources
  const selectedSource = sources.find(item => item.id === source)
  const entries = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    return (snapshot?.entries ?? []).filter(entry => (
      (filter === 'all' || isProblem(entry.level))
      && (!normalizedSearch || entry.text.toLocaleLowerCase().includes(normalizedSearch))
    ))
  }, [filter, search, snapshot?.entries])

  useEffect(() => {
    if (!following || !viewportRef.current) return
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight
  }, [entries.length, following, snapshot?.generatedAt])

  const chooseSource = (nextSource: ProcessLogSource) => {
    setSource(nextSource)
    setSearch('')
    setFilter('all')
    setFollowing(true)
  }

  const toggleLive = () => {
    if (live) {
      setLive(false)
      return
    }
    setLive(true)
    void query.refetch()
  }

  const returnToLatest = () => {
    setFollowing(true)
    if (viewportRef.current) viewportRef.current.scrollTop = viewportRef.current.scrollHeight
  }

  return (
    <>
      <PageHeader
        title="进程日志"
        description="先看时间、模块和发生了什么；结构化字段、错误堆栈和原文需要时再展开。"
        generatedAt={snapshot?.generatedAt ?? initialSnapshot.generatedAt}
        isRefreshing={query.isFetching}
        refreshFailed={query.isError}
      />

      <div className="log-source-bar">
        <label className="log-source-select">
          <span>日志来源</span>
          <select aria-label="日志来源" value={source} onChange={event => chooseSource(event.target.value as ProcessLogSource)}>
            {sources.map(item => <option key={item.id} value={item.id}>{item.label}{item.exists ? '' : '（无日志）'}</option>)}
          </select>
        </label>
        <div className="log-source-summary">
          <span className={`log-source-status ${selectedSource?.exists ? 'log-source-status--ready' : ''}`} />
          {selectedSource?.exists
            ? `${formatCount(selectedSource.sizeBytes)} bytes · 更新于 ${formatTimestamp(selectedSource.updatedAt)}`
            : '尚无日志'}
        </div>
        <button type="button" className={`log-live-toggle ${live ? 'log-live-toggle--active' : ''}`} onClick={toggleLive}>
          {live ? <Pause size={13} /> : <Play size={13} />}
          {live ? '暂停实时更新' : '继续实时更新'}
        </button>
      </div>

      <Panel
        className="mt-4"
        title={sources.find(item => item.id === source)?.label ?? source}
        description="默认展示最新记录；页面最多读取文件尾部 512 KiB、保留 500 条。"
      >
        <div className="log-toolbar">
          <SearchInput value={search} onChange={setSearch} label="搜索日志" placeholder="搜索正文、模块或字段" />
          <div className="log-filter-group" role="group" aria-label="日志筛选">
            <button type="button" className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>全部</button>
            <button type="button" className={filter === 'problems' ? 'is-active' : ''} onClick={() => setFilter('problems')}>只看问题</button>
          </div>
          <span className="log-result-count">{entries.length} / {snapshot?.entries.length ?? 0} 条</span>
        </div>

        {!snapshot || query.isPending ? (
          <EmptyState>正在读取 {source} 日志…</EmptyState>
        ) : entries.length === 0 ? (
          <EmptyState>{snapshot.entries.length === 0 ? '当前进程还没有日志。' : '没有匹配当前筛选条件的日志。'}</EmptyState>
        ) : (
          <div className="log-viewport-wrap">
            <div
              ref={viewportRef}
              className="log-viewport"
              role="log"
              aria-live="off"
              onScroll={event => {
                const element = event.currentTarget
                setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 32)
              }}
            >
              {entries.map(entry => <LogEntry key={`${entry.sequence}-${entry.text}`} entry={entry} />)}
            </div>
            {!following && <button type="button" className="log-return-latest" onClick={returnToLatest}><ArrowDown size={13} />回到最新</button>}
          </div>
        )}
      </Panel>

      <WarningList warnings={snapshot?.warnings ?? []} />
    </>
  )
}

function LogEntry({ entry }: { entry: ProcessLogEntry }) {
  const hasDetails = entry.metadata !== null || entry.detail !== null
  return (
    <article className={`log-entry log-entry--${entry.level}`}>
      <time dateTime={entry.timestamp ?? undefined}>{formatLogTime(entry.timestamp, entry.sequence)}</time>
      <StatusBadge tone={levelTone(entry.level)}>{entry.level}</StatusBadge>
      <div className="log-entry-content">
        <div className="log-entry-heading">
          {entry.scope && <span className="log-scope">{entry.scope}</span>}
          <p>{entry.message}</p>
        </div>
        {hasDetails && (
          <details className="log-entry-details">
            <summary>查看详情</summary>
            {entry.metadata && <div><span>结构化字段</span><JsonBlock value={entry.metadata} variant="preview" /></div>}
            {entry.detail && <div><span>错误详情</span><pre>{entry.detail}</pre></div>}
            <div><span>原始记录</span><pre>{entry.text}</pre></div>
          </details>
        )}
      </div>
    </article>
  )
}

function formatLogTime(timestamp: string | null, sequence: number): string {
  if (!timestamp) return `#${sequence}`
  const parts = Object.fromEntries(logTimeFormatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]))
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

function isProblem(level: ProcessLogLevel): boolean {
  return level === 'warn' || level === 'error' || level === 'fatal'
}

function levelTone(level: ProcessLogLevel): 'neutral' | 'good' | 'warn' | 'bad' | 'info' {
  if (level === 'fatal' || level === 'error') return 'bad'
  if (level === 'warn') return 'warn'
  if (level === 'info') return 'good'
  if (level === 'debug' || level === 'trace') return 'info'
  return 'neutral'
}
