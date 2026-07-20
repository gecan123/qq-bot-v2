import { Link } from '@tanstack/react-router'
import { ArrowUpRight, MessagesSquare } from 'lucide-react'
import { JsonBlock, PageHeader, Panel, StatCard, StatGrid, StatusBadge } from '../../components/AdminUi.js'
import { formatCount, formatTimestamp } from '../../lib/format.js'
import type { QqSnapshot } from './qq.schema.js'

export function QqView({ snapshot, isRefreshing, refreshFailed }: { snapshot: QqSnapshot; isRefreshing: boolean; refreshFailed: boolean }) {
  return <>
    <PageHeader title="QQ / Media" description="查看 QQ 入站事实账本与媒体缓存；点击群聊进入独立消息页面。" generatedAt={snapshot.generatedAt} isRefreshing={isRefreshing} refreshFailed={refreshFailed}/>
    <StatGrid><StatCard label="Messages" value={formatCount(snapshot.counts.messages)}/><StatCard label="Groups" value={formatCount(snapshot.counts.groups)}/><StatCard label="Media" value={formatCount(snapshot.counts.media)}/><StatCard label="Sticker pool" value={formatCount(snapshot.counts.stickers)}/></StatGrid>
    <Panel className="mt-4" title="群聊" description="按最后活跃时间排序；进入后只显示该群数据。"><div className="group-grid">{snapshot.groups.map(group => <Link key={group.groupId} to="/qq/group/$groupId" params={{ groupId: group.groupId }} className="group-card"><span className="group-card-icon"><MessagesSquare size={17}/></span><span className="min-w-0 flex-1"><strong>{group.name}</strong><small>群 {group.groupId} · {formatCount(group.messageCount)} 条<br/>最后活跃 {formatTimestamp(group.lastAt)}</small></span><ArrowUpRight size={14}/></Link>)}</div></Panel>
    <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">{snapshot.note}</div>
    <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]">
      <Panel title="最近跨会话消息"><div className="max-h-[820px] overflow-auto">{snapshot.messages.map(row => <MessageRow key={row.id} row={row}/>)}</div></Panel>
      <Panel title="最近小图与 Sticker"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">{snapshot.media.map(item => <MediaCard key={item.id} item={item}/>)}</div></Panel>
    </div>
  </>
}

function MessageRow({ row }: { row: QqSnapshot['messages'][number] }) { return <article className="qq-message-row"><div className="flex flex-wrap items-center gap-2"><strong>{row.sender}</strong><StatusBadge tone={row.sceneKind === 'qq_private' ? 'info' : 'neutral'}>{row.scene}</StatusBadge><span>#{row.id} · {formatTimestamp(row.at)}</span></div><p>{row.text}</p>{row.mediaReferenceIds.length > 0 && <small>media: {row.mediaReferenceIds.join(', ')}</small>}</article> }
function MediaCard({ item }: { item: QqSnapshot['media'][number] }) { return <article className="qq-media-card">{item.dataUrl ? <img src={item.dataUrl} alt={item.description || item.fileName || `media ${item.id}`} loading="lazy"/> : <div className="qq-media-empty">无缩略图</div>}<div className="p-3"><div className="flex flex-wrap gap-1">{item.stickerName && <StatusBadge tone="good">{item.stickerName}</StatusBadge>}{item.stickerTags.map(tag => <StatusBadge key={tag}>{tag}</StatusBadge>)}</div><p className="mb-0 mt-2 break-all text-xs text-stone-500">media #{item.id} · {item.contentType ?? 'unknown'} · {formatCount(item.fileSize)} bytes</p>{item.description && (item.descriptionIsJson ? <div className="mt-2"><JsonBlock value={item.description} variant="preview" /></div> : <p className="mb-0 mt-2 whitespace-pre-wrap text-xs leading-5">{item.description}</p>)}</div></article> }
