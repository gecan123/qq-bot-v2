export const BEIJING_TIME_ZONE = 'Asia/Shanghai'
export const BEIJING_UTC_OFFSET = '+08:00'

interface BeijingDateParts {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
}

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BEIJING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function beijingParts(date: Date): BeijingDateParts {
  const values = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  return {
    year: values.get('year') ?? '',
    month: values.get('month') ?? '',
    day: values.get('day') ?? '',
    hour: values.get('hour') ?? '',
    minute: values.get('minute') ?? '',
    second: values.get('second') ?? '',
  }
}

/** 可解析、字节稳定且明确携带北京时间偏移的时间格式。 */
export function formatBeijingIso(date: Date): string {
  const parts = beijingParts(date)
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}${BEIJING_UTC_OFFSET}`
}

/** 面向人类阅读的北京时间，不携带偏移；调用方应在标签中写明“北京时间”。 */
export function formatBeijingDateTime(date: Date): string {
  const parts = beijingParts(date)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

export function formatBeijingMonth(date: Date): string {
  const parts = beijingParts(date)
  return `${parts.year}-${parts.month}`
}

export function formatBeijingCompact(date: Date): string {
  const parts = beijingParts(date)
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}${milliseconds}`
}

/** 兼容历史 UTC `Z` 字符串和新的 `+08:00` 字符串，按绝对时刻倒序。 */
export function compareTimestampsDesc(left: string | null, right: string | null): number {
  const leftMs = left == null ? Number.NaN : Date.parse(left)
  const rightMs = right == null ? Number.NaN : Date.parse(right)
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return rightMs - leftMs
  }
  return (right ?? '').localeCompare(left ?? '')
}
