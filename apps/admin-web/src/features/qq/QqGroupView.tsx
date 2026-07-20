import { Link } from '@tanstack/react-router'
import { ArrowLeft, ImageIcon, Users } from 'lucide-react'
import { JsonBlock, PageHeader, Panel, StatCard, StatGrid, StatusBadge } from '../../components/AdminUi.js'
import { formatCount, formatTimestamp } from '../../lib/format.js'
import type { QqGroupSnapshot } from './qq.schema.js'

export function QqGroupView({ snapshot, isRefreshing, refreshFailed }: { snapshot: QqGroupSnapshot; isRefreshing: boolean; refreshFailed: boolean }) {
  return <>
    <Link to="/qq" className="memory-back"><ArrowLeft size={14}/>返回 QQ / Media</Link>
    <PageHeader title={snapshot.group.name} description={`群 ${snapshot.group.groupId} · 最新消息在前 · 只读`} generatedAt={snapshot.generatedAt} isRefreshing={isRefreshing} refreshFailed={refreshFailed}/>
    <StatGrid>
      <StatCard label="Total messages" value={formatCount(snapshot.group.totalMessages)} detail={snapshot.group.windowLimited ? '页面展示最近 300 条' : '已展示全部'}/>
      <StatCard label="Participants" value={formatCount(snapshot.participants.length)} detail="当前消息窗口"/>
      <StatCard label="Related media" value={formatCount(snapshot.media.length)} detail="当前消息窗口"/>
      <StatCard label="Last active" value={formatTimestamp(snapshot.group.lastAt)} detail={snapshot.group.firstAt ? `最早 ${formatTimestamp(snapshot.group.firstAt)}` : '—'}/>
    </StatGrid>
    <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_340px]">
      <Panel title="群消息" description={snapshot.group.windowLimited ? '数据库消息较多，当前展示最近 300 条。' : '当前群全部消息。'}><div className="max-h-[1100px] overflow-auto">{snapshot.messages.map(row => <article key={row.id} className="qq-message-row"><div className="flex flex-wrap items-center gap-2"><strong>{row.sender}</strong><span>QQ {row.senderId}</span><span>#{row.id} · {formatTimestamp(row.at)}</span></div><p>{row.text}</p>{row.mediaReferenceIds.length > 0 && <small>media: {row.mediaReferenceIds.join(', ')}</small>}</article>)}</div></Panel>
      <div className="space-y-4">
        <Panel title="活跃成员" description="按当前消息窗口内的消息数排序。"><div className="participant-list">{snapshot.participants.map(person => <div key={person.senderId} className="participant-row"><span className="participant-icon"><Users size={13}/></span><span className="min-w-0 flex-1"><strong>{person.name}</strong><small>QQ {person.senderId} · {formatTimestamp(person.lastAt)}</small></span><StatusBadge>{person.messages}</StatusBadge></div>)}</div></Panel>
        {snapshot.media.length > 0 && <Panel title="相关媒体"><div className="grid gap-3">{snapshot.media.map(item => <article key={item.id} className="qq-media-card">{item.dataUrl ? <img src={item.dataUrl} alt={item.description || item.fileName || `media ${item.id}`} loading="lazy"/> : <div className="qq-media-empty"><ImageIcon size={15}/>无缩略图</div>}<div className="p-3"><p className="m-0 text-xs text-stone-500">media #{item.id}</p>{item.description && (item.descriptionIsJson ? <div className="mt-2"><JsonBlock value={item.description} variant="preview"/></div> : <p className="mb-0 mt-2 whitespace-pre-wrap text-xs">{item.description}</p>)}</div></article>)}</div></Panel>}
      </div>
    </div>
  </>
}
