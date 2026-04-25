import type { ActionRecord } from './agent-runtime-types.js'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

export function getActionRecordText(actionRecord: Pick<ActionRecord, 'resultPayload'>): string | null {
  const payload = actionRecord.resultPayload
  const proposedEffect = asRecord(payload?.proposedEffect)
  const text = typeof proposedEffect?.text === 'string'
    ? proposedEffect.text.trim()
    : typeof payload?.text === 'string'
      ? payload.text.trim()
      : ''
  return text || null
}

export function getActionRecordAnchor(actionRecord: Pick<ActionRecord, 'resultPayload'>): number | null {
  const payload = actionRecord.resultPayload
  const sourceRefs = asRecord(payload?.sourceRefs)
  return getNumber(sourceRefs?.incorporatedMessageRowId) ?? getNumber(sourceRefs?.messageRowId) ?? getNumber(payload?.incorporatedMessageRowId) ?? getNumber(payload?.messageRowId)
}
