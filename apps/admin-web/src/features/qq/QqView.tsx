import { Link } from '@tanstack/react-router'
import { ArrowUpRight, MessagesSquare } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState, JsonBlock, PageHeader, Panel, SearchInput, StatCard, StatGrid, StatusBadge } from '../../components/AdminUi.js'
import { formatCount, formatTimestamp } from '../../lib/format.js'
import type { QqSnapshot } from './qq.schema.js'

export function QqView({ snapshot, isRefreshing, refreshFailed }: { snapshot: QqSnapshot; isRefreshing: boolean; refreshFailed: boolean }) {
  const [search, setSearch] = useState('')
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const conversations = useMemo(() => snapshot.conversations.filter(item => !normalizedSearch || [item.platform, item.name, item.externalId, item.accountId].some(value => value.toLocaleLowerCase().includes(normalizedSearch))), [normalizedSearch, snapshot.conversations])
  const messages = useMemo(() => snapshot.messages.filter(row => !normalizedSearch || [row.scene, row.sender, row.senderId, row.text, String(row.id)].some(value => value.toLocaleLowerCase().includes(normalizedSearch))), [normalizedSearch, snapshot.messages])
  const media = useMemo(() => snapshot.media.filter(item => !normalizedSearch || [item.fileName, item.description, item.stickerName, ...item.stickerTags].some(value => value?.toLocaleLowerCase().includes(normalizedSearch))), [normalizedSearch, snapshot.media])

  return <>
    <PageHeader title="Conversations / Media" description="查看 QQ 与飞书共享的入站事实账本、会话和媒体缓存。" generatedAt={snapshot.generatedAt} isRefreshing={isRefreshing} refreshFailed={refreshFailed}/>
    <StatGrid><StatCard label="Messages" value={formatCount(snapshot.counts.messages)}/><StatCard label="Conversations" value={formatCount(snapshot.counts.conversations)}/><StatCard label="Media" value={formatCount(snapshot.counts.media)}/><StatCard label="Sticker pool" value={formatCount(snapshot.counts.stickers)}/></StatGrid>
    <div className="filter-toolbar mt-4"><SearchInput value={search} onChange={setSearch} label="搜索会话" placeholder="搜索平台、会话、发送者或消息"/><span className="filter-count">{conversations.length} / {snapshot.conversations.length} 个会话 · {messages.length} / {snapshot.messages.length} 条最近消息</span></div>
    <Panel className="mt-4" title="会话" description="按最后活跃时间排序；QQ 群保留独立下钻入口。"><div className="group-grid">{conversations.map(item => item.platform === 'qq' && item.kind === 'group' ? <Link key={`${item.platform}:${item.accountId}:${item.kind}:${item.externalId}`} to="/qq/group/$groupId" params={{ groupId: item.externalId }} className="group-card"><span className="group-card-icon"><MessagesSquare size={17}/></span><span className="min-w-0 flex-1"><strong>{item.name}</strong><small>QQ · {item.kind} · {formatCount(item.messageCount)} 条<br/>最后活跃 {formatTimestamp(item.lastAt)}</small></span><ArrowUpRight size={14}/></Link> : <div key={`${item.platform}:${item.accountId}:${item.kind}:${item.externalId}`} className="group-card"><span className="group-card-icon"><MessagesSquare size={17}/></span><span className="min-w-0 flex-1"><strong>{item.name}</strong><small>{item.platform.toUpperCase()} · {item.kind} · {formatCount(item.messageCount)} 条<br/>最后活跃 {formatTimestamp(item.lastAt)}</small></span></div>)}</div>{conversations.length === 0 && <EmptyState>没有匹配的会话</EmptyState>}</Panel>
    <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">{snapshot.note}</div>
    <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]">
      <Panel title="最近跨会话消息"><div className="max-h-[820px] overflow-auto">{messages.length ? messages.map(row => <MessageRow key={row.id} row={row}/>) : <EmptyState>没有匹配的最近消息</EmptyState>}</div></Panel>
      <Panel title="最近小图与 Sticker">{media.length ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">{media.map(item => <MediaCard key={item.id} item={item}/>)}</div> : <EmptyState>没有匹配的媒体</EmptyState>}</Panel>
    </div>
  </>
}

function MessageRow({ row }: { row: QqSnapshot['messages'][number] }) { return <article className="qq-message-row"><div className="flex flex-wrap items-center gap-2"><strong>{row.sender}</strong><StatusBadge tone={row.conversationKind === 'private' ? 'info' : 'neutral'}>{row.platform.toUpperCase()} · {row.scene}</StatusBadge><span>#{row.id} · {formatTimestamp(row.at)}</span></div><p>{row.text}</p>{row.mediaReferenceIds.length > 0 && <small>media: {row.mediaReferenceIds.join(', ')}</small>}</article> }
function MediaCard({ item }: { item: QqSnapshot['media'][number] }) { return <article className="qq-media-card">{item.dataUrl ? <img src={item.dataUrl} alt={item.description || item.fileName || `media ${item.id}`} loading="lazy"/> : <div className="qq-media-empty">无缩略图</div>}<div className="p-3"><div className="flex flex-wrap gap-1">{item.stickerName && <StatusBadge tone="good">{item.stickerName}</StatusBadge>}{item.stickerTags.map(tag => <StatusBadge key={tag}>{tag}</StatusBadge>)}</div><p className="mb-0 mt-2 break-all text-xs text-stone-500">media #{item.id} · {item.contentType ?? 'unknown'} · {formatCount(item.fileSize)} bytes</p>{item.description && (item.descriptionIsJson ? <div className="mt-2"><JsonBlock value={item.description} variant="preview" /></div> : <p className="mb-0 mt-2 whitespace-pre-wrap text-xs leading-5">{item.description}</p>)}</div></article> }
