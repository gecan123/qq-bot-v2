import type { MediaDescription } from '../types/message-segments.js'

function getString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function isMediaDescription(value: unknown): value is MediaDescription {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
}

export function getMediaDescriptionText(value: unknown): string | null {
  if (!isMediaDescription(value)) return null

  const directKeys = ['description', 'summary', 'transcription', 'transcript', 'ocrText'] as const
  for (const key of directKeys) {
    const text = getString(value[key])
    if (text) return text
  }

  const extractedText = value.extractedText
  if (Array.isArray(extractedText)) {
    const parts = extractedText
      .map((item) => getString(item))
      .filter((item): item is string => item !== null)
    if (parts.length > 0) return parts.join('；')
  }

  return null
}
