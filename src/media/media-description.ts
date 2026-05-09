import type { MediaDescription } from '../types/message-segments.js'

export interface FormattedMediaDescription {
  body: string
  detectedType?: string
}

function getString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function joinExtractedText(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const parts = value
    .map((item) => getString(item))
    .filter((item): item is string => item !== null)
  return parts.length > 0 ? parts.join('；') : null
}

export function isMediaDescription(value: unknown): value is MediaDescription {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
}

export function formatMediaDescription(value: unknown): FormattedMediaDescription | null {
  if (!isMediaDescription(value)) return null

  const description = getString(value.description)
  const summary = getString(value.summary)
  const transcription = getString(value.transcription) ?? getString(value.transcript)
  const ocrText = getString(value.ocrText)
  const extracted = joinExtractedText(value.extractedText)
  const memeContext = getString(value.memeContext)
  const intentSignal = getString(value.intentSignal)
  const detectedType = getString(value.detectedType) ?? undefined

  const parts: string[] = []
  const primary = description ?? summary ?? transcription ?? ocrText ?? extracted
  if (primary) parts.push(primary)

  if (description && summary) parts.push(`概要:${summary}`)
  if (primary !== extracted && extracted) parts.push(`文字:${extracted}`)
  if (memeContext) parts.push(`梗:${memeContext}`)
  if (intentSignal) parts.push(`推测意图:${intentSignal}`)
  if (typeof value.confidence === 'number' && Number.isFinite(value.confidence)) {
    parts.push(`置信度:${value.confidence.toFixed(2)}`)
  }

  if (parts.length === 0) return null
  return { body: parts.join(' | '), detectedType }
}

export function getMediaDescriptionText(value: unknown): string | null {
  return formatMediaDescription(value)?.body ?? null
}
