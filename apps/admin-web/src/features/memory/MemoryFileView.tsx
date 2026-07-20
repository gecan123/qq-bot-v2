import { Link } from '@tanstack/react-router'
import { ArrowLeft, FileText, Link2 } from 'lucide-react'
import { JsonBlock, PageHeader, Panel, StatCard, StatGrid, StatusBadge } from '../../components/AdminUi.js'
import { formatCount, formatTimestamp } from '../../lib/format.js'
import type { MemoryFileSnapshot } from './memory.schema.js'

export function MemoryFileView({ snapshot, isRefreshing, refreshFailed }: { snapshot: MemoryFileSnapshot; isRefreshing: boolean; refreshFailed: boolean }) {
  const active = snapshot.entries.filter(entry => entry.status === 'active' || entry.status === null).length
  return <>
    <Link to="/memory" className="memory-back"><ArrowLeft size={14}/>返回 Memory / Life</Link>
    <PageHeader title={snapshot.file.title} description={snapshot.file.path} generatedAt={snapshot.generatedAt} isRefreshing={isRefreshing} refreshFailed={refreshFailed}/>
    <StatGrid>
      <StatCard label="File type" value={snapshot.file.kind} detail="只读 Markdown"/>
      <StatCard label="Entries" value={formatCount(snapshot.entries.length)} detail={`${active} active / visible`}/>
      <StatCard label="File size" value={`${formatCount(snapshot.file.size)} B`} detail={formatTimestamp(snapshot.file.updatedAt)}/>
      <StatCard label="Source messages" value={formatCount(snapshot.provenance.length)} tone={snapshot.provenance.length ? 'good' : 'warn'}/>
    </StatGrid>
    <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_360px]">
      <Panel title="完整条目" description="按文件中的原始顺序展示，不再截断正文。">
        {snapshot.entries.length === 0 ? <div className="empty-state">该文件没有可解析条目；可在原始 Markdown 中查看。</div> : <div>{snapshot.entries.map(entry => <article id={entry.id} key={entry.id} className="memory-entry-detail"><div className="memory-entry-heading"><div className="flex flex-wrap items-center gap-2"><code>{entry.id}</code>{entry.tier && <StatusBadge tone={entry.tier === 'stable' ? 'good' : 'neutral'}>{entry.tier}</StatusBadge>}{entry.status && <StatusBadge tone={entry.status === 'active' ? 'good' : 'warn'}>{entry.status}</StatusBadge>}{entry.evidenceKind && <StatusBadge tone={entry.evidenceKind === 'legacy_unverified' ? 'warn' : 'info'}>{entry.evidenceKind}</StatusBadge>}</div>{entry.updatedAt && <time>{formatTimestamp(entry.updatedAt)}</time>}</div><div className="memory-entry-content">{entry.text}</div>{entry.sourceMessageIds.length > 0 && <div className="memory-source-ids"><Link2 size={12}/>sourceMessageIds: {entry.sourceMessageIds.join(', ')}</div>}</article>)}</div>}
      </Panel>
      <div className="space-y-4">
        <Panel title="文件信息"><div className="mb-3 flex items-center gap-2 text-xs text-stone-500"><FileText size={14}/><span className="break-all">{snapshot.file.path}</span></div><JsonBlock value={snapshot.file.metadata}/></Panel>
        {snapshot.provenance.length > 0 && <Panel title="QQ 来源消息"><div className="max-h-[520px] overflow-auto">{snapshot.provenance.map(row => <article key={row.id} className="memory-provenance"><strong>#{row.id} · {row.sender}</strong><small>{row.scene} · {formatTimestamp(row.sentAt)}</small><p>{row.text}</p></article>)}</div></Panel>}
      </div>
    </div>
    <Panel className="mt-4" title="原始 Markdown" description="保留文件字节内容，便于核对解析结果。"><pre className="memory-markdown-source">{snapshot.file.rawMarkdown}</pre></Panel>
  </>
}
