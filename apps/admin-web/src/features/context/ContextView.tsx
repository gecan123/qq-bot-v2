import { ArrowDown, Bell, ChevronRight, Wrench } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { EmptyState, JsonBlock, PageHeader, Panel, StatusBadge, WarningList } from '../../components/AdminUi.js'
import { formatCount, formatDuration, formatTimestamp } from '../../lib/format.js'
import type { ContextSnapshot } from './context.schema.js'

type ContextEntry = ContextSnapshot['entries'][number]
type MessageEntry = Extract<ContextEntry, { kind: 'message' }>
type EvidenceDigest = NonNullable<
  NonNullable<ContextSnapshot['recentLlmCalls'][number]['evidence']>['canonicalRequest']
>

export function ContextView({ snapshot, isRefreshing, refreshFailed, isDemo = false }: {
  snapshot: ContextSnapshot
  isRefreshing: boolean
  refreshFailed: boolean
  isDemo?: boolean
}) {
  const usage = snapshot.latestUsage
  const activity = summarizeVisibleToolActivity(snapshot.entries)
  return <>
    <PageHeader
      title={isDemo ? '主 Agent 观测 · 示例' : '主 Agent 观测'}
      description="沿 canonical ledger 观察主 Agent 的对话、动作链与异常；页面只在完整快照到达后刷新。"
      generatedAt={snapshot.generatedAt}
      isRefreshing={isRefreshing}
      refreshFailed={refreshFailed}
    />
    {isDemo && (
      <aside className="context-demo-notice" aria-label="示例数据说明">
        <strong>示例数据，不是实际运行记录</strong>
        <span>此页面只使用前端内存中的代表性数据，不读取或写入 Ledger。</span>
        <a href="/context">返回真实数据</a>
      </aside>
    )}
    <Panel
      className="main-agent-panel"
      title="对话与动作"
      description="每个回合直接展示有效工具名、关键参数和结果摘要；完整输入、输出与 Ledger 关联按需展开。"
    >
      <div className="context-session-bar" aria-label="主 Agent 观测摘要">
        <section className="context-tool-usage" aria-label="工具使用统计">
          <div className="context-tool-usage-title" aria-label={`${activity.total} 次工具调用`}><Wrench size={13} /><span>工具调用</span><strong>{formatCount(activity.total)}</strong></div>
          <div className="context-tool-usage-list">
            {activity.tools.length > 0
              ? activity.tools.map(tool => (
                  <span
                    key={tool.name}
                    className={`context-tool-usage-chip${tool.failed > 0 ? ' context-tool-usage-chip--bad' : tool.pending > 0 ? ' context-tool-usage-chip--pending' : ''}`}
                    aria-label={toolActivityLabel(tool)}
                  >
                    <code>{tool.name}</code><strong>×{formatCount(tool.count)}</strong>
                    {tool.failed > 0 && <small>{tool.failed} 失败</small>}
                    {tool.pending > 0 && <small>{tool.pending} 未返回</small>}
                  </span>
                ))
              : <span className="context-tool-usage-empty">当前可见范围暂无工具调用</span>}
          </div>
        </section>
        <div className="context-session-facts">
          <span><strong>#{snapshot.ledger.headId ?? '—'}</strong> 最新 entry</span>
          <span className={activity.failed > 0 ? 'context-session-alert' : ''} aria-label={`${activity.failed} 次失败`}><strong>{formatCount(activity.failed)}</strong> 失败</span>
          <span className={activity.pending > 0 ? 'context-session-warn' : ''} aria-label={`${activity.pending} 次未返回`}><strong>{formatCount(activity.pending)}</strong> 未返回</span>
          <span><strong>{usage?.model ?? '—'}</strong> model</span>
          <span><strong>{formatCount(snapshot.entries.length)} / {formatCount(snapshot.ledger.total)}</strong> 可见 entries</span>
        </div>
      </div>
      <ConversationTranscript entries={snapshot.entries} headId={snapshot.ledger.headId} />
    </Panel>

    <details className="context-technical mt-4">
      <summary><ChevronRight size={14} />Ledger 技术信息</summary>
      <div className="context-technical-body">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(280px,1fr)]">
          <Panel title="Entry 构成">
            {snapshot.ledger.typeCounts.map(item => <div key={item.type} className="mb-2 flex items-center justify-between gap-3 rounded-lg bg-stone-100 px-3 py-2 text-sm"><span>{entryTypeLabel(item.type)}</span><strong>{formatCount(item.count)}</strong></div>)}
          </Panel>
          <Panel title="Runtime projection 指针">
            <dl className="space-y-2 text-sm">
              <Metric label="Runtime head" value={snapshot.runtime.ledgerHeadId ?? '—'} />
              <Metric label="Checkpoint through" value={snapshot.ledger.checkpointThroughId ?? '—'} />
              <Metric label="Checkpoint updated" value={formatTimestamp(snapshot.ledger.checkpointUpdatedAt)} />
              <Metric label="Goal revision" value={String(snapshot.runtime.goalRevision ?? '—')} />
              <Metric label="Runtime updated" value={formatTimestamp(snapshot.runtime.updatedAt)} />
            </dl>
          </Panel>
        </div>
        <RecentLlmCalls calls={snapshot.recentLlmCalls} />
      </div>
    </details>
    <WarningList warnings={snapshot.warnings} />
  </>
}

function ConversationTranscript({ entries, headId }: { entries: ContextEntry[]; headId: string | null }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const pairedResults = useMemo(() => pairToolResults(entries), [entries])

  useEffect(() => {
    if (!following || !viewportRef.current) return
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight
  }, [entries, following, headId])

  const returnToLatest = () => {
    setFollowing(true)
    if (viewportRef.current) viewportRef.current.scrollTop = viewportRef.current.scrollHeight
  }

  return (
    <div className="agent-transcript-wrap">
      <div
        ref={viewportRef}
        className="agent-transcript"
        role="log"
        aria-label="主 Agent canonical 对话"
        aria-live="off"
        onScroll={event => {
          const element = event.currentTarget
          setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 40)
        }}
      >
        {entries.length === 0
          ? <EmptyState><span>canonical ledger 还没有可显示的对话。<a className="context-demo-link" href="/context?demo=1">查看完整示例</a></span></EmptyState>
          : entries.map(entry => {
              if (entry.kind === 'message' && entry.role === 'tool' && pairedResults.pairedIds.has(entry.id)) return null
              if (entry.kind === 'compaction') return <CompactionMessage key={entry.id} entry={entry} />
              if (entry.kind === 'unknown') return <UnknownMessage key={entry.id} entry={entry} />
              if (entry.role === 'user') return <UserMessage key={entry.id} entry={entry} />
              if (entry.role === 'assistant') return <AssistantMessage key={entry.id} entry={entry} results={pairedResults.byCall} />
              return <OrphanToolResult key={entry.id} entry={entry} />
            })}
      </div>
      {!following && <button type="button" className="agent-return-latest" onClick={returnToLatest}><ArrowDown size={13} />回到最新</button>}
    </div>
  )
}

function pairToolResults(entries: ContextEntry[]) {
  const byCall = new Map<string, MessageEntry>()
  const pairedIds = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.role !== 'tool' || !entry.parentEntryId || !entry.toolCallId) continue
    byCall.set(`${entry.parentEntryId}:${entry.toolCallId}`, entry)
    pairedIds.add(entry.id)
  }
  return { byCall, pairedIds }
}

type ToolActivityItem = { name: string; count: number; failed: number; pending: number }

function summarizeVisibleToolActivity(entries: ContextEntry[]): {
  total: number
  failed: number
  pending: number
  tools: ToolActivityItem[]
} {
  const results = pairToolResults(entries).byCall
  const tools = new Map<string, ToolActivityItem>()
  let total = 0
  let failed = 0
  let pending = 0
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue
    total += entry.toolCalls.length
    for (const call of entry.toolCalls) {
      const result = results.get(`${entry.id}:${call.id}`) ?? null
      const tool = tools.get(call.displayName) ?? { name: call.displayName, count: 0, failed: 0, pending: 0 }
      tool.count += 1
      if (result === null) {
        pending += 1
        tool.pending += 1
      } else if (result.result?.ok === false) {
        failed += 1
        tool.failed += 1
      }
      tools.set(call.displayName, tool)
    }
  }
  return {
    total,
    failed,
    pending,
    tools: [...tools.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
  }
}

function toolActivityLabel(tool: ToolActivityItem): string {
  const problems = [
    tool.failed > 0 ? `${tool.failed} 次失败` : null,
    tool.pending > 0 ? `${tool.pending} 次未返回` : null,
  ].filter((value): value is string => value !== null)
  return `${tool.name} ${tool.count} 次${problems.length > 0 ? `，${problems.join('，')}` : ''}`
}

function UserMessage({ entry }: { entry: MessageEntry }) {
  const notification = parseNotification(entry.summary)
  if (notification) return <NotificationMessage entry={entry} notification={notification} />
  return (
    <article className="agent-message agent-message--user" aria-label={`用户消息 #${entry.id}`}>
      <div className="agent-user-bubble"><MarkdownBody>{entry.summary}</MarkdownBody></div>
      <MessageFooter entry={entry} />
    </article>
  )
}

type NotificationDigest = {
  title: string
  conversation: string | null
  count: number | null
  delivery: string | null
}

function NotificationMessage({ entry, notification }: { entry: MessageEntry; notification: NotificationDigest }) {
  return (
    <article className="agent-message agent-message--event" aria-label={`系统通知 #${entry.id}`}>
      <div className="agent-event-card">
        <header className="agent-event-heading">
          <span><Bell size={13} />系统通知</span>
          {notification.delivery && <small>{notification.delivery}</small>}
        </header>
        <div className="agent-event-body">
          <div><strong>{notification.title}</strong>{notification.conversation && <span>{notification.conversation}</span>}</div>
          {notification.count !== null && <b>{notification.count} 条新消息</b>}
        </div>
        <details className="agent-event-detail">
          <summary><ChevronRight size={12} />查看完整事件</summary>
          <pre>{entry.summary}</pre>
        </details>
      </div>
      <MessageFooter entry={entry} />
    </article>
  )
}

function parseNotification(value: string): NotificationDigest | null {
  if (!value.trimStart().startsWith('{')) return null
  try {
    const payload = recordValue(JSON.parse(value))
    if (!payload || payload.event !== 'notification') return null
    const source = recordValue(payload.source)
    const data = recordValue(payload.data)
    const conversation = recordValue(data?.conversation)
    const platform = stringValue(conversation?.platform) ?? stringValue(source?.type)
    const kind = stringValue(source?.kind) ?? stringValue(payload.kind) ?? 'notification'
    const conversationKind = conversation?.kind === 'private' ? '私聊' : conversation?.kind === 'group' ? '群聊' : null
    const externalId = stringValue(conversation?.externalId)
    const conversationLabel = platform && conversationKind
      ? `${platform.toUpperCase()} ${conversationKind}${externalId ? ` · ${externalId}` : ''}`
      : stringValue(source?.mailbox)
    const rawCount = source?.count ?? payload.count
    const count = typeof rawCount === 'number' && Number.isFinite(rawCount) ? rawCount : null
    return {
      title: `${platform?.toUpperCase() ?? 'Runtime'} ${kind}`,
      conversation: conversationLabel,
      count,
      delivery: stringValue(source?.delivery) ?? stringValue(payload.delivery),
    }
  } catch {
    return null
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function AssistantMessage({ entry, results }: { entry: MessageEntry; results: Map<string, MessageEntry> }) {
  const hasReply = entry.summary.trim().length > 0
  return (
    <article className="agent-message agent-message--assistant" aria-label={`Main Agent 消息 #${entry.id}`}>
      {hasReply && <div className="agent-message-label">Agent 回复</div>}
      {hasReply && <MarkdownBody>{entry.summary}</MarkdownBody>}
      {entry.toolCalls.length > 0 && (
        <section className="agent-process-group" role="region" aria-label={`Agent 动作 #${entry.id}`}>
          <header className="agent-process-heading">
            <strong>动作链</strong>
            <span>{toolGroupSummary(entry, results)}</span>
          </header>
          <div className="agent-tool-stack">
            {entry.toolCalls.map(call => <ToolCallCard
              key={call.id}
              call={call}
              result={results.get(`${entry.id}:${call.id}`) ?? null}
            />)}
          </div>
        </section>
      )}
      <MessageFooter entry={entry} />
    </article>
  )
}

function ToolCallCard({ call, result }: {
  call: MessageEntry['toolCalls'][number]
  result: MessageEntry | null
}) {
  const status = toolStatus(result)
  return (
    <article
      className={`agent-tool-call agent-tool-call--${status.tone}`}
      aria-label={`工具调用 ${call.displayName} · ${status.label}`}
    >
      <header className="agent-tool-heading">
        <div className="agent-tool-identity">
          <span className="agent-tool-name">{call.displayName}</span>
          {call.transportName && <span className="agent-tool-transport">通过 {call.transportName}</span>}
        </div>
        <span className="agent-tool-status">{status.label}</span>
      </header>
      {call.parameters.length > 0
        ? <dl className="agent-tool-parameters">
            {call.parameters.map(parameter => <div key={parameter.label}>
              <dt>{parameter.label}</dt><dd>{parameter.value}</dd>
            </div>)}
          </dl>
        : <p className="agent-tool-empty">无调用参数</p>}
      <div className="agent-tool-result">
        <span>结果</span>
        <p>{toolResultPreview(result)}</p>
      </div>
      <details className="agent-tool-detail">
        <summary><ChevronRight size={12} />完整输入、输出与 Ledger 关联</summary>
        <div className="agent-tool-detail-body">
          <div><span>调用参数</span><pre>{call.argsPreview}</pre></div>
          <div>
            <span>工具结果{result ? ` · entry #${result.id}` : ''}</span>
            {result?.summary ? <pre>{result.summary}</pre> : <p className="agent-tool-empty">{result ? '无文本输出' : '尚未返回'}</p>}
          </div>
          <details className="agent-raw-detail">
            <summary>原始结果 Ledger JSON</summary>
            <JsonBlock value={result?.rawPreview ?? null} variant="preview" />
          </details>
        </div>
      </details>
    </article>
  )
}

function OrphanToolResult({ entry }: { entry: MessageEntry }) {
  const status = toolStatus(entry)
  return (
    <article className="agent-message agent-message--tool" aria-label={`未配对工具结果 #${entry.id}`}>
      <div className="agent-message-label">未配对工具结果</div>
      <div className={`agent-tool-call agent-tool-call--${status.tone}`}>
        <div className="agent-orphan-tool-heading"><span className="agent-tool-name">{entry.toolName ?? 'unknown_tool'}</span><span>{status.label}</span></div>
        {entry.summary && <pre>{entry.summary}</pre>}
      </div>
      <MessageFooter entry={entry} />
    </article>
  )
}

function CompactionMessage({ entry }: { entry: Extract<ContextEntry, { kind: 'compaction' }> }) {
  const tokenChange = entry.tokensBefore !== null && entry.estimatedTokensAfter !== null
    ? `${formatCount(entry.tokensBefore)} → ${formatCount(entry.estimatedTokensAfter)} tokens`
    : null
  return (
    <article className="agent-compaction" aria-label={`Compaction #${entry.id}`}>
      <header><span>compaction</span><time dateTime={entry.createdAt}>{formatTimestamp(entry.createdAt)}</time></header>
      <div className="agent-compaction-body">
        <h2>会话已压缩</h2>
        <p>此处之前的主 Agent 历史已压缩为以下摘要：</p>
        <MarkdownBody>{entry.summary}</MarkdownBody>
        <div className="agent-compaction-meta">
          {[entry.reason, tokenChange, entry.firstKeptEntryId ? `保留自 #${entry.firstKeptEntryId}` : null, entry.isSplitTurn ? 'split turn' : null]
            .filter((value): value is string => value !== null)
            .map(value => <span key={value}>{value}</span>)}
        </div>
        <details className="agent-raw-detail"><summary>原始 Ledger JSON</summary><JsonBlock value={entry.rawPreview} variant="preview" /></details>
      </div>
    </article>
  )
}

function UnknownMessage({ entry }: { entry: Extract<ContextEntry, { kind: 'unknown' }> }) {
  return (
    <article className="agent-message agent-message--unknown" role="alert">
      <strong>无法解析 entry #{entry.id}</strong>
      <p>{entry.parseError}</p>
      <details className="agent-raw-detail"><summary>原始 Ledger JSON</summary><JsonBlock value={entry.rawPreview} variant="preview" /></details>
    </article>
  )
}

function MessageFooter({ entry }: { entry: MessageEntry }) {
  return (
    <footer className="agent-message-footer">
      <span>#{entry.id}</span>
      <time dateTime={entry.createdAt}>{formatTimestamp(entry.createdAt)}</time>
      <details className="agent-raw-detail"><summary>技术细节</summary><JsonBlock value={entry.rawPreview} variant="preview" /></details>
    </footer>
  )
}

function MarkdownBody({ children }: { children: string }) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => {
            const linkProps = { ...props }
            const label = linkProps.children
            delete linkProps.children
            delete linkProps.node
            return <a {...linkProps} target="_blank" rel="noreferrer">{label}</a>
          },
          img: ({ alt, src }) => <span className="agent-image-placeholder">[图片：{alt || src || '未命名'}]</span>,
          table: ({ children: tableChildren }) => <div className="agent-markdown-table"><table>{tableChildren}</table></div>,
        }}
      >{children}</ReactMarkdown>
    </div>
  )
}

function RecentLlmCalls({ calls }: { calls: ContextSnapshot['recentLlmCalls'] }) {
  return (
    <Panel
      className="mt-4"
      title="最近 LLM 调用"
      description="只读结构证据：四段指纹、工具名、耗时与停止原因；不保存 prompt、response 正文，也不参与 replay。"
    >
      {calls.length === 0
        ? <EmptyState>暂无带 callId 的 LLM 调用记录；旧 usage 行不会伪装成 trace。</EmptyState>
        : <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr className="border-b text-xs text-stone-500">
                <th className="p-2">时间 / 调用</th><th className="p-2">归属</th><th className="p-2">Provider</th>
                <th className="p-2">结果</th><th className="p-2">Tokens</th><th className="p-2">四段证据</th>
              </tr></thead>
              <tbody>{calls.map(call => <tr key={call.callId} className="border-b border-stone-100 align-top">
                <td className="whitespace-nowrap p-2 text-xs">{formatTimestamp(call.ts)}<div className="font-mono text-stone-500">{call.callId.slice(0, 8)}</div></td>
                <td className="p-2"><strong>{call.operation}</strong><div className="text-xs text-stone-500">{call.actor ?? '未归因'}</div></td>
                <td className="p-2"><span>{call.provider ?? '未知 provider'} · {call.model}</span><div className="text-xs text-stone-500">{formatDuration(call.durationMs)}</div></td>
                <td className="p-2"><StatusBadge tone={call.status === 'succeeded' ? 'good' : call.status === 'aborted' ? 'warn' : 'bad'}>{call.status}</StatusBadge><div className="mt-1 text-xs text-stone-500">{call.stopReason ?? call.errorKind ?? '—'}</div></td>
                <td className="whitespace-nowrap p-2 text-xs">{formatCount(call.inputTokens)} in<br/>{formatCount(call.cachedTokens)} cached<br/>{formatCount(call.outputTokens)} out</td>
                <td className="min-w-64 p-2">{call.evidence
                  ? <div className="grid gap-1 text-xs"><Evidence label="C→" value={call.evidence.canonicalRequest}/><Evidence label="P→" value={call.evidence.providerRequest}/><Evidence label="P←" value={call.evidence.providerResponse}/><Evidence label="C←" value={call.evidence.canonicalResponse}/></div>
                  : <span className="text-xs text-stone-500">无结构证据</span>}</td>
              </tr>)}</tbody>
            </table>
          </div>}
    </Panel>
  )
}

function toolStatus(entry: MessageEntry | null): { label: string; tone: 'ok' | 'bad' | 'pending' } {
  if (!entry) return { label: '未返回', tone: 'pending' }
  if (entry.result?.ok === false) return { label: '失败', tone: 'bad' }
  return { label: '成功', tone: 'ok' }
}

function toolGroupSummary(entry: MessageEntry, results: Map<string, MessageEntry>): string {
  let succeeded = 0
  let failed = 0
  let pending = 0
  for (const call of entry.toolCalls) {
    const status = toolStatus(results.get(`${entry.id}:${call.id}`) ?? null).tone
    if (status === 'ok') succeeded += 1
    else if (status === 'bad') failed += 1
    else pending += 1
  }
  const statuses = [
    succeeded > 0 ? `${succeeded} 成功` : null,
    failed > 0 ? `${failed} 失败` : null,
    pending > 0 ? `${pending} 未返回` : null,
  ].filter((value): value is string => value !== null)
  return `${entry.toolCalls.length} 次调用 · ${statuses.join(' · ')}`
}

function toolResultPreview(entry: MessageEntry | null): string {
  if (!entry) return '等待工具返回'
  if (entry.summary.trim()) return singleLinePreview(entry.summary)
  return entry.result?.ok === false ? (entry.result.code ?? '工具返回失败') : '已返回，无文本摘要'
}

function singleLinePreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 120)}…`
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-stone-500">{label}</dt><dd className="m-0 break-all text-right font-medium">{value}</dd></div>
}

function entryTypeLabel(value: string): string {
  if (value === 'message') return '普通历史（message）'
  if (value === 'compaction') return '压缩边界（compaction）'
  return value
}

function Evidence({ label, value }: { label: string; value: EvidenceDigest | null }) {
  if (!value) return <div className="text-stone-400">{label} —</div>
  return <div><span className="mr-2 font-mono text-stone-500">{label} {value.fingerprint.slice(0, 8)}</span>{value.toolNames.length > 0 && <span>{value.toolNames.join(', ')}</span>}</div>
}
