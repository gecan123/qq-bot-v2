import { AlertTriangle, Clock3, LoaderCircle, Radio } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatTimestamp } from '../lib/format.js'

export function PageHeader({ title, description, generatedAt, isRefreshing = false, refreshFailed = false }: {
  title: string
  description: string
  generatedAt?: string
  isRefreshing?: boolean
  refreshFailed?: boolean
}) {
  return (
    <header className="page-header">
      <div className="min-w-0">
        <div className="page-kicker"><Radio size={12} strokeWidth={2.2} /> Agent observatory</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {generatedAt && (
        <div className={`freshness-chip ${refreshFailed ? 'freshness-chip--bad' : isRefreshing ? 'freshness-chip--loading' : ''}`} aria-live="polite">
          {refreshFailed ? <><AlertTriangle size={13} />刷新失败 · 上一帧</>
            : isRefreshing ? <><LoaderCircle className="animate-spin" size={13} />正在同步</>
              : <><Clock3 size={13} />{formatTimestamp(generatedAt)}</>}
        </div>
      )}
    </header>
  )
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <section className="stat-grid">{children}</section>
}

export function StatCard({ label, value, detail, tone = 'neutral' }: {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'
}) {
  return (
    <article className={`stat-card stat-card--${tone}`}>
      <div className="stat-card-glow" aria-hidden="true" />
      <p className="stat-label">{label}</p>
      <div className="stat-value">{value}</div>
      {detail !== undefined && <div className="stat-detail">{detail}</div>}
    </article>
  )
}

export function Panel({ title, description, children, className = '' }: {
  title: string
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-header">
        <div className="panel-title-row"><span className="panel-title-mark" /><h2>{title}</h2></div>
        {description && <p>{description}</p>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

export function StatusBadge({ children, tone = 'neutral' }: {
  children: ReactNode
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'
}) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state"><span className="empty-state-dot" />{children}</div>
}

export function WarningList({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return (
    <section className="warning-box">
      <div className="warning-title"><AlertTriangle size={15} />数据告警</div>
      <ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
    </section>
  )
}

export function JsonBlock({ value, variant = 'block' }: { value: unknown; variant?: 'block' | 'preview' }) {
  return <pre className={`json-block json-block--${variant}`}>{formatPrettyJson(value)}</pre>
}

function formatPrettyJson(value: unknown): string {
  let normalized = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { normalized = JSON.parse(trimmed) } catch { return value }
    } else {
      return value
    }
  }
  try { return JSON.stringify(normalized, null, 2) ?? String(normalized) } catch { return String(normalized) }
}
