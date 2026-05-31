import type { BrowserActionInput, BrowserElementSummary } from './protocol.js'

export type BrowserRiskLevel = 'low' | 'normal' | 'high'

export interface BrowserRiskInput {
  action: BrowserActionInput['action']
  url?: string
  element?: BrowserElementSummary | null
  text?: string
  fileName?: string
  contentType?: string
}

export interface BrowserRiskResult {
  level: BrowserRiskLevel
  reason: string
  requiresOwnerHelp: boolean
}

const HIGH_RISK_TEXT_RE =
  /\b(pay|purchase|buy now|subscribe|checkout|billing|refund|delete account|close account|change password|reset password|2fa|two[- ]factor|passkey|oauth|authorize|connect app|grant access|export data|identity|passport|driver'?s license|ssn|bank|card number|cvv)\b/i

const NORMAL_RISK_TEXT_RE =
  /\b(post|comment|reply|like|follow|star|bookmark|save|publish|upload|submit)\b/i

const LOW_RISK_TEXT_RE =
  /\b(i am human|verify you are human|continue|accept cookies|accept all|agree|close|dismiss|expand|show more|read more)\b/i

const HIGH_RISK_FIELD_RE =
  /\b(password|passwd|passcode|2fa|two[- ]factor|otp|one[- ]time|verification code|auth code|security code|card|cvv|token|secret|api key|cookie)\b/i

const HIGH_RISK_EXT_RE = /\.(?:dmg|pkg|exe|msi|app|bat|cmd|ps1|sh|bash|zsh|jar|scr|com|zip|rar|7z|tar|gz)$/i
const HIGH_RISK_CONTENT_TYPE_RE =
  /(?:application\/x-msdownload|application\/x-apple-diskimage|application\/x-sh|application\/x-executable|application\/zip|application\/x-7z-compressed|application\/x-rar)/i

export function classifyBrowserActionRisk(input: BrowserRiskInput): BrowserRiskResult {
  if (input.action === 'request_owner_help') {
    return high('owner help was explicitly requested')
  }

  if (input.action === 'download') {
    return classifyDownload(input.fileName, input.contentType)
  }

  if (input.action === 'type') {
    const fieldText = normalizeRiskText([
      input.element?.label,
      input.element?.type,
      input.element?.role,
      input.element?.tagName,
    ])
    if (HIGH_RISK_FIELD_RE.test(fieldText)) {
      return high('typing into a sensitive credential/security/payment field')
    }
    return normal('typing into a normal page field')
  }

  if (input.action !== 'click') {
    return low('read/navigation/browser control action')
  }

  const text = normalizeRiskText([
    input.element?.label,
    input.element?.type,
    input.element?.href,
    input.element?.role,
    input.url,
    input.text,
  ])

  if (HIGH_RISK_TEXT_RE.test(text)) return high('target looks like payment/account/security/OAuth/destructive action')
  if (LOW_RISK_TEXT_RE.test(text)) return low('target looks like routine browsing friction')
  if (NORMAL_RISK_TEXT_RE.test(text)) return normal('target looks like normal account participation')
  return low('ordinary click')
}

export function classifyDownload(fileName?: string, contentType?: string): BrowserRiskResult {
  const name = fileName ?? ''
  const type = contentType ?? ''
  if (HIGH_RISK_EXT_RE.test(name) || HIGH_RISK_CONTENT_TYPE_RE.test(type)) {
    return high('download looks executable, installable, script-like, or archive-like')
  }
  return normal('download looks like a normal resource')
}

export function shouldRedactBrowserKey(key: string): boolean {
  return /(?:password|passwd|token|secret|cookie|authorization|2fa|otp|card|cvv|api[_-]?key)/i.test(key)
}

export function redactBrowserValue(value: unknown, key = ''): unknown {
  if (shouldRedactBrowserKey(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    if (HIGH_RISK_FIELD_RE.test(key)) return '[REDACTED]'
    if (value.length > 240) return `${value.slice(0, 240)}...[truncated ${value.length - 240} chars]`
    return value
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactBrowserValue(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value).slice(0, 40)) {
      out[childKey] = redactBrowserValue(childValue, childKey)
    }
    return out
  }
  return value
}

function normalizeRiskText(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function low(reason: string): BrowserRiskResult {
  return { level: 'low', reason, requiresOwnerHelp: false }
}

function normal(reason: string): BrowserRiskResult {
  return { level: 'normal', reason, requiresOwnerHelp: false }
}

function high(reason: string): BrowserRiskResult {
  return { level: 'high', reason, requiresOwnerHelp: true }
}
