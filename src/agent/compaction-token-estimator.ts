import { Buffer } from 'node:buffer'
import type { AgentMessage } from './agent-context.types.js'
import type { AgentLedgerEntry } from './agent-ledger.types.js'

export type TokenEstimateSource = 'provider_prefix' | 'local_structure' | 'utf8_bytes'

export interface EntryTokenEstimate {
  entryId: bigint
  tokens: number
  source: Exclude<TokenEstimateSource, 'provider_prefix'>
}

export interface MessageTokenEstimate {
  tokens: number
  source: Exclude<TokenEstimateSource, 'provider_prefix'>
}

export interface LedgerContextTokenEstimate {
  tokens: number
  source: TokenEstimateSource
  estimatedEntryIds: bigint[]
  entries: EntryTokenEstimate[]
}

export interface ProviderTokenPrefix {
  throughEntryId: bigint | null
  inputTokens: number
}

const MESSAGE_ENVELOPE_TOKENS = 8
const STRUCTURED_ENVELOPE_TOKENS = 16
const UTF8_BYTES_PER_TOKEN = 4

export function estimateUtf8Tokens(value: string, envelopeTokens = 0): number {
  if (!Number.isSafeInteger(envelopeTokens) || envelopeTokens < 0) {
    throw new RangeError('envelopeTokens must be a non-negative safe integer')
  }
  const bytes = Buffer.byteLength(value, 'utf8')
  const contentTokens = Math.max(1, Math.ceil(bytes / UTF8_BYTES_PER_TOKEN))
  return safeAdd(contentTokens, envelopeTokens)
}

export function estimateEntryTokens(entry: AgentLedgerEntry): EntryTokenEstimate {
  if (entry.entryType === 'compaction') {
    return {
      entryId: entry.id,
      tokens: estimateUtf8Tokens(JSON.stringify(entry.payload), STRUCTURED_ENVELOPE_TOKENS),
      source: 'local_structure',
    }
  }

  return {
    entryId: entry.id,
    ...estimateMessageTokens(entry.payload.message),
  }
}

export function estimateMessageTokens(message: AgentMessage): MessageTokenEstimate {
  if (hasLocalStructure(message)) {
    return {
      tokens: estimateUtf8Tokens(JSON.stringify(message), STRUCTURED_ENVELOPE_TOKENS),
      source: 'local_structure',
    }
  }
  const plainContent = message.role === 'tool'
    ? typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    : message.content
  return {
    tokens: estimateUtf8Tokens(plainContent, MESSAGE_ENVELOPE_TOKENS),
    source: 'utf8_bytes',
  }
}

export function estimateLedgerContextTokens(input: {
  entries: readonly AgentLedgerEntry[]
  providerPrefix?: ProviderTokenPrefix
}): LedgerContextTokenEstimate {
  const prefix = input.providerPrefix
  if (prefix) validateProviderPrefix(prefix, input.entries)
  const entriesToEstimate = prefix == null
    ? [...input.entries]
    : input.entries.filter((entry) => (
        prefix.throughEntryId == null || entry.id > prefix.throughEntryId
      ))
  const entries = entriesToEstimate.map(estimateEntryTokens)
  const estimatedTokens = entries.reduce((sum, estimate) => safeAdd(sum, estimate.tokens), 0)
  const tokens = prefix == null
    ? estimatedTokens
    : safeAdd(prefix.inputTokens, estimatedTokens)
  return {
    tokens,
    source: prefix == null
      ? aggregateLocalSource(entries)
      : 'provider_prefix',
    estimatedEntryIds: entries.map((estimate) => estimate.entryId),
    entries,
  }
}

function hasLocalStructure(message: AgentMessage): boolean {
  return message.role === 'assistant'
    ? message.toolCalls.length > 0 || message.nativeBlocks !== undefined
    : message.role === 'tool' && typeof message.content !== 'string'
}

function aggregateLocalSource(entries: readonly EntryTokenEstimate[]): LedgerContextTokenEstimate['source'] {
  return entries.some((entry) => entry.source === 'local_structure')
    ? 'local_structure'
    : 'utf8_bytes'
}

function validateProviderPrefix(
  prefix: ProviderTokenPrefix,
  entries: readonly AgentLedgerEntry[],
): void {
  if (!Number.isSafeInteger(prefix.inputTokens) || prefix.inputTokens < 0) {
    throw new RangeError('providerPrefix.inputTokens must be a non-negative safe integer')
  }
  if (prefix.throughEntryId == null) return
  if (typeof prefix.throughEntryId !== 'bigint' || prefix.throughEntryId <= 0n) {
    throw new RangeError('providerPrefix.throughEntryId must be a positive bigint or null')
  }
  if (!entries.some((entry) => entry.id === prefix.throughEntryId)) {
    throw new RangeError('providerPrefix.throughEntryId must exist in entries')
  }
}

function safeAdd(left: number, right: number): number {
  const value = left + right
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER
}
