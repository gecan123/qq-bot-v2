import { Link } from '@tanstack/react-router'
import { ArrowUpRight, FileText } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState, PageHeader, Panel, SearchInput, StatCard, StatGrid, StatusBadge, WarningList } from '../../components/AdminUi.js'
import { formatCount, formatTimestamp } from '../../lib/format.js'
import type { MemorySnapshot } from './memory.schema.js'

export function MemoryView({ snapshot, isRefreshing, refreshFailed }: { snapshot: MemorySnapshot; isRefreshing: boolean; refreshFailed: boolean }) {
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<'all' | MemorySnapshot['files'][number]['kind']>('all')
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filteredEntries = useMemo(() => snapshot.entries.filter(entry => (
    (kind === 'all' || snapshot.files.find(file => file.fileId === entry.fileId)?.kind === kind)
    && (!normalizedSearch || [entry.id, entry.file, entry.text, entry.tier, entry.status, entry.evidenceKind].some(value => value?.toLocaleLowerCase().includes(normalizedSearch)))
  )), [kind, normalizedSearch, snapshot.entries, snapshot.files])
  const matchingFileIds = new Set(filteredEntries.map(entry => entry.fileId))
  const filteredFiles = snapshot.files.filter(file => (
    (kind === 'all' || file.kind === kind)
    && (!normalizedSearch || matchingFileIds.has(file.fileId) || file.path.toLocaleLowerCase().includes(normalizedSearch))
  ))

  return <>
    <PageHeader title="Memory / Notebook 溯源" description="浏览稳定长期记忆与跨天过程笔记；点击文件或条目可进入完整只读页面。" generatedAt={snapshot.generatedAt} isRefreshing={isRefreshing} refreshFailed={refreshFailed}/>
    <StatGrid><StatCard label="Knowledge files" value={snapshot.counts.files}/><StatCard label="Memory entries" value={snapshot.counts.memoryEntries}/><StatCard label="Notebook entries" value={snapshot.counts.notebookEntries}/><StatCard label="Source links" value={snapshot.counts.sourceLinks} tone={snapshot.counts.sourceLinks ? 'good' : 'warn'}/></StatGrid>
    <div className="filter-toolbar mt-4">
      <SearchInput value={search} onChange={setSearch} label="搜索知识" placeholder="搜索内容、文件名或条目 ID" />
      <select aria-label="知识类型" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="all">全部类型</option><option value="memory">Memory</option><option value="notebook">Notebook</option></select>
      <span className="filter-count">{filteredFiles.length} / {snapshot.files.length} 文件 · {filteredEntries.length} / {snapshot.entries.length} 条目</span>
    </div>
    <div className="mt-4 grid items-start gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
      <Panel title="文件清单" description="打开独立页面查看完整 Markdown 与条目。"><div className="max-h-[740px] overflow-auto">{filteredFiles.length ? filteredFiles.map(file => <Link key={file.path} to="/memory/$fileId" params={{ fileId: file.fileId }} className="memory-file-link"><span className="memory-file-icon"><FileText size={15}/></span><span className="min-w-0 flex-1"><strong>{file.path}</strong><small>{file.kind} · {file.entryCount} entries · {formatCount(file.size)} bytes<br/>{formatTimestamp(file.updatedAt)}</small></span><ArrowUpRight size={13}/></Link>) : <EmptyState>没有匹配的知识文件</EmptyState>}</div></Panel>
      <Panel title="最近条目" description="摘要用于发现；点击任意条目查看所在文件的完整页面。"><div className="max-h-[740px] overflow-auto">{filteredEntries.length ? filteredEntries.map(entry => <article key={entry.id} className="memory-entry-summary"><div className="flex flex-wrap items-center gap-2"><code>{entry.id}</code>{entry.tier && <StatusBadge tone={entry.tier === 'stable' ? 'good' : 'neutral'}>{entry.tier}</StatusBadge>}{entry.status && <StatusBadge tone={entry.status === 'active' ? 'good' : 'warn'}>{entry.status}</StatusBadge>}{entry.evidenceKind && <StatusBadge tone={entry.evidenceKind === 'legacy_unverified' ? 'warn' : 'info'}>{entry.evidenceKind}</StatusBadge>}</div><p>{entry.text}</p><Link to="/memory/$fileId" params={{ fileId: entry.fileId }} hash={entry.id} className="memory-entry-open">查看完整页面 <ArrowUpRight size={12}/></Link></article>) : <EmptyState>没有匹配的知识条目</EmptyState>}</div></Panel>
    </div>
    {snapshot.provenance.length > 0 && <Panel className="mt-4" title="QQ 来源消息">{snapshot.provenance.map(row => <div key={row.id} className="border-b py-3 text-sm"><strong>#{row.id} · {row.sender}</strong><span className="ml-2 text-xs text-stone-500">{row.scene} · {formatTimestamp(row.sentAt)}</span><p className="mb-0 mt-1">{row.text}</p></div>)}</Panel>}
    <WarningList warnings={snapshot.warnings}/>
  </>
}
