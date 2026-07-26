import { createHash } from 'node:crypto'

export interface LlmEvidenceSummary {
  model?: string
  systemChars?: number
  messageCount?: number
  messageRoles?: string[]
  contentBlockTypes?: string[]
  toolNames?: string[]
  toolChoice?: string
  cacheBreakpointCount?: number
  maxOutputTokens?: number
  contentChars?: number
  stopReason?: string
  httpStatus?: number
}

export interface LlmEvidenceDigest {
  fingerprint: string
  summary: LlmEvidenceSummary
}

export interface LlmProviderEvidence {
  provider: 'claude-code' | 'openai-agent'
  request: LlmEvidenceDigest
  response?: LlmEvidenceDigest
}

export interface LlmCallTraceEvidence {
  canonicalRequest: LlmEvidenceDigest
  providerRequest?: LlmEvidenceDigest
  providerResponse?: LlmEvidenceDigest
  canonicalResponse?: LlmEvidenceDigest
}

const providerEvidenceKey = Symbol('llm-provider-evidence')

export function createLlmEvidenceDigest(
  value: unknown,
  summary: LlmEvidenceSummary,
): LlmEvidenceDigest {
  return createLlmEvidenceDigestFromSerialized(stableJson(value), summary)
}

export function createLlmEvidenceDigestFromSerialized(
  serialized: string,
  summary: LlmEvidenceSummary,
): LlmEvidenceDigest {
  return {
    fingerprint: createHash('sha256').update(serialized).digest('hex'),
    summary,
  }
}

export function createLlmEvidenceDigestFromParts(
  parts: readonly unknown[],
  summary: LlmEvidenceSummary,
): LlmEvidenceDigest {
  const hash = createHash('sha256')
  for (const part of parts) {
    const serialized = typeof part === 'string' ? part : stableJson(part)
    hash.update(String(serialized.length))
    hash.update(':')
    hash.update(serialized)
  }
  return { fingerprint: hash.digest('hex'), summary }
}

export function attachLlmProviderEvidence(
  error: unknown,
  evidence: LlmProviderEvidence,
): void {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return
  try {
    Object.defineProperty(error, providerEvidenceKey, {
      configurable: true,
      enumerable: false,
      value: evidence,
    })
  } catch {
    // Observation evidence must never replace or mask the provider error.
  }
}

export function readLlmProviderEvidence(error: unknown): LlmProviderEvidence | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined
  return (error as Record<PropertyKey, unknown>)[providerEvidenceKey] as LlmProviderEvidence | undefined
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => (
    typeof current === 'bigint' ? current.toString() : current
  )) ?? String(value)
}
