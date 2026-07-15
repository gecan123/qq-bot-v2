import { z } from 'zod'
import type { ToolResultContentBlock } from '../agent/agent-context.types.js'

export const BROWSER_ACTIONS = [
  'help',
  'status',
  'open',
  'switch_page',
  'close_page',
  'observe',
  'click',
  'type',
  'press',
  'scroll',
  'screenshot',
  'download',
  'annotate',
  'request_owner_help',
] as const

export type BrowserActionName = (typeof BROWSER_ACTIONS)[number]

export const BROWSER_OBSERVE_ELEMENT_LIMIT = 30
export const BROWSER_TEXT_OUTPUT_LIMIT = 6_000
export const BROWSER_LABEL_LIMIT = 160

export const browserActionInputSchema = z.object({
  action: z.enum(BROWSER_ACTIONS),
  pageId: z.string().trim().min(1).max(80).optional(),
  url: z.string().trim().url().optional(),
  newPage: z.boolean().optional(),
  elementId: z.string().trim().min(1).max(120).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  text: z.string().max(8_000).optional(),
  clear: z.boolean().optional(),
  key: z.string().trim().min(1).max(80).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().int().positive().max(10_000).optional(),
  fullPage: z.boolean().optional(),
  artifactId: z.string().trim().min(1).max(160).optional(),
  reason: z.string().trim().min(1).max(1_000).optional(),
})

export type BrowserActionInput = z.infer<typeof browserActionInputSchema>

export interface BrowserPageSummary {
  pageId: string
  url: string
  title: string
  active: boolean
  loadState: 'loading' | 'domcontentloaded' | 'networkidle' | 'unknown'
  closed: boolean
  lastUsedAt: string
}

export interface BrowserElementSummary {
  elementId: string
  role: string
  label: string
  tagName: string
  type?: string
  href?: string
  disabled?: boolean
  visible?: boolean
}

export interface BrowserActionJsonResult {
  ok: boolean
  action: BrowserActionName
  truncated?: boolean
  omittedElements?: number
  message?: string
  error?: string
  code?: string
  requiresOwnerHelp?: boolean
  risk?: 'low' | 'normal' | 'high'
  reason?: string
  pageId?: string
  url?: string
  title?: string
  activePageId?: string
  pages?: BrowserPageSummary[]
  elements?: BrowserElementSummary[]
  artifactId?: string
  artifactPath?: string
  fileName?: string
  contentType?: string
  byteSize?: number
  image?: Extract<ToolResultContentBlock, { type: 'image' }>
}

export interface BrowserControllerConfig {
  profileDir: string
  artifactDir: string
  actionLogPath: string
  actionTimeoutMs: number
  artifactMaxFiles?: number
  artifactMaxAgeMs?: number
  headless?: boolean
  humanize?: boolean
  humanPreset?: 'default' | 'careful'
  proxy?: string
  geoip?: boolean
  timezone?: string
  locale?: string
  extensionPaths?: string[]
  args?: string[]
}

export function clampBrowserText(value: string, max = BROWSER_TEXT_OUTPUT_LIMIT): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 32).trimEnd()}\n[...truncated ${value.length - max} chars]`
}

export function clampBrowserLabel(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= BROWSER_LABEL_LIMIT) return normalized
  return `${normalized.slice(0, BROWSER_LABEL_LIMIT - 1).trimEnd()}…`
}

export function browserJsonResultToText(result: BrowserActionJsonResult): string {
  const clone: BrowserActionJsonResult = { ...result }
  if (clone.image) {
    clone.image = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: clone.image.source.media_type,
        data: `[base64 image omitted from text summary: ${clone.image.source.data.length} chars]`,
      },
    }
  }

  let serialized = JSON.stringify(clone)
  if (serialized.length <= BROWSER_TEXT_OUTPUT_LIMIT) return serialized

  if (clone.elements) {
    const elements = [...clone.elements]
    clone.elements = elements
    clone.truncated = true
    clone.omittedElements = 0
    while (elements.length > 0) {
      elements.pop()
      clone.omittedElements++
      serialized = JSON.stringify(clone)
      if (serialized.length <= BROWSER_TEXT_OUTPUT_LIMIT) return serialized
    }
  }

  const fallback: BrowserActionJsonResult = {
    ok: clone.ok,
    action: clone.action,
    truncated: true,
    message: 'browser result exceeded the text limit; retry with a narrower action',
    ...(clone.pageId ? { pageId: clone.pageId } : {}),
    ...(clone.url ? { url: clone.url } : {}),
    ...(clone.title ? { title: clone.title } : {}),
    ...(clone.code ? { code: clone.code } : {}),
    ...(clone.error ? { error: clone.error } : {}),
  }
  serialized = JSON.stringify(fallback)
  if (serialized.length <= BROWSER_TEXT_OUTPUT_LIMIT) return serialized
  return JSON.stringify({
    ok: clone.ok,
    action: clone.action,
    truncated: true,
    message: 'browser result exceeded the text limit',
  })
}
