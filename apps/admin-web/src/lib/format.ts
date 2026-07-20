export function formatTimestamp(value: string | null): string {
  if (value === null) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: false,
  }).format(new Date(value))
}

export function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-US')
}

export function formatPercent(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`
}

export function formatDuration(value: number | null): string {
  if (value === null) return '—'
  if (value < 1_000) return `${value} ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`
  return `${(value / 60_000).toFixed(1)} min`
}

export function truncateText(value: string, max = 180): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}
