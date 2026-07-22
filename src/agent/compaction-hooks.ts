import type { CompactionAgentLedgerEntry, CompactionReason } from './agent-ledger.types.js'
import type { ReadyCompactionPreparation } from './compaction.js'

export type BeforeCompactResult =
  | { action: 'continue' }
  | { action: 'cancel'; reason: string }
  | { action: 'use_summary'; summary: string }

export interface BeforeCompactEvent {
  preparation: ReadyCompactionPreparation
  reason: CompactionReason
  signal: AbortSignal
}

export interface AfterCompactMetrics {
  tokensBefore: number
  estimatedTokensAfter: number
  compressedEntryCount?: number
  keptEntryCount?: number
}

export interface AfterCompactEvent {
  committedEntry: CompactionAgentLedgerEntry
  metrics: AfterCompactMetrics
}

export interface CompactionHooks {
  beforeCompact?(event: BeforeCompactEvent): Promise<BeforeCompactResult>
  afterCompact?(event: AfterCompactEvent): Promise<void>
}

export async function runBeforeCompactHook(
  hooks: CompactionHooks,
  event: BeforeCompactEvent,
): Promise<BeforeCompactResult> {
  if (event.signal.aborted) return { action: 'cancel', reason: 'aborted' }
  if (!hooks.beforeCompact) return { action: 'continue' }
  const result = await hooks.beforeCompact(event)
  if (result.action === 'continue') return result
  if (result.action === 'cancel' && result.reason.trim() !== '') return result
  if (result.action === 'use_summary') return result
  throw new TypeError('beforeCompact returned an invalid result')
}

export async function runAfterCompactHook(
  hooks: CompactionHooks,
  event: AfterCompactEvent,
  onError?: (error: Error) => void,
): Promise<{ ok: true } | { ok: false; error: Error }> {
  if (!hooks.afterCompact) return { ok: true }
  try {
    await hooks.afterCompact(event)
    return { ok: true }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    try {
      onError?.(error)
    } catch {
      // Post-commit diagnostics are best-effort and must never affect committed state.
    }
    return { ok: false, error }
  }
}
