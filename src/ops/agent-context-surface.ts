import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { CLAUDE_CODE_BILLING_HEADER } from '../agent/claude-code/headers.js'
import { estimateUtf8Tokens } from '../agent/compaction-token-estimator.js'
import type { Tool } from '../agent/tool.js'
import {
  zodToOpenAIStrictToolJsonSchema,
  zodToToolJsonSchema,
} from '../agent/tool-schema.js'

export const AGENT_CONTEXT_SURFACE_SCHEMA_VERSION = 1 as const
export const AGENT_CONTEXT_SURFACE_PATH = 'logs/context-surface.json'

export interface AgentContextSurface {
  schemaVersion: 1
  generatedAt: string
  pid: number
  provider: 'claude-code' | 'openai-agent'
  model: string
  contextWindowTokens: number
  systemIdentity: { bytes: number; tokens: number }
  botSystemPrompt: { bytes: number; tokens: number }
  tools: {
    totalBytes: number
    totalTokens: number
    items: Array<{ name: string; bytes: number; tokens: number }>
  }
  fingerprint: string
}

export type AgentContextSurfaceReadResult =
  | { status: 'available'; surface: AgentContextSurface }
  | { status: 'missing' }
  | { status: 'invalid'; error: string }

export type AgentContextSurfaceStatus = 'live' | 'last_startup' | 'missing' | 'invalid'

type ReadTextFile = (path: string, encoding: 'utf8') => Promise<string>
type KillProcess = (pid: number, signal: 0) => boolean

const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const maxSafeIntegerBigInt = BigInt(Number.MAX_SAFE_INTEGER)
const metricSchema = z.object({
  bytes: nonNegativeSafeIntegerSchema,
  tokens: nonNegativeSafeIntegerSchema,
}).strict()
const positiveSafeIntegerSchema = nonNegativeSafeIntegerSchema.positive()
const toolMetricSchema = metricSchema.extend({ name: z.string().min(1) }).strict()
const agentContextSurfaceSchema = z.object({
  schemaVersion: z.literal(AGENT_CONTEXT_SURFACE_SCHEMA_VERSION),
  generatedAt: z.iso.datetime({ offset: true }),
  pid: positiveSafeIntegerSchema,
  provider: z.enum(['claude-code', 'openai-agent']),
  model: z.string().min(1),
  contextWindowTokens: positiveSafeIntegerSchema,
  systemIdentity: metricSchema,
  botSystemPrompt: metricSchema,
  tools: z.object({
    totalBytes: nonNegativeSafeIntegerSchema,
    totalTokens: nonNegativeSafeIntegerSchema,
    items: z.array(toolMetricSchema),
  }).strict(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((surface, ctx) => {
  const totalBytes = sumBigInts(surface.tools.items.map((item) => item.bytes))
  const totalTokens = sumBigInts(surface.tools.items.map((item) => item.tokens))
  if (BigInt(surface.tools.totalBytes) !== totalBytes) {
    ctx.addIssue({ code: 'custom', path: ['tools', 'totalBytes'], message: 'must equal item bytes' })
  }
  if (BigInt(surface.tools.totalTokens) !== totalTokens) {
    ctx.addIssue({ code: 'custom', path: ['tools', 'totalTokens'], message: 'must equal item tokens' })
  }
})

export function buildAgentContextSurface(input: {
  provider: 'claude-code' | 'openai-agent'
  model: string
  contextWindowTokens: number
  systemPrompt: string
  tools: Tool[]
  generatedAt: string
  pid: number
}): AgentContextSurface {
  const declarations = input.tools.map((tool) => buildProviderToolDeclaration(input.provider, tool))
  const items = input.tools.map((tool, index) => ({
    name: tool.name,
    ...measure(JSON.stringify(declarations[index])),
  }))

  return {
    schemaVersion: AGENT_CONTEXT_SURFACE_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    pid: input.pid,
    provider: input.provider,
    model: input.model,
    contextWindowTokens: input.contextWindowTokens,
    systemIdentity: measure(serializeSystemIdentity(input.provider)),
    botSystemPrompt: measure(input.systemPrompt),
    tools: {
      totalBytes: sumSafeIntegers(items.map((item) => item.bytes), 'tool bytes'),
      totalTokens: sumSafeIntegers(items.map((item) => item.tokens), 'tool tokens'),
      items,
    },
    fingerprint: createHash('sha256').update(stableStringify({
      provider: input.provider,
      model: input.model,
      contextWindowTokens: input.contextWindowTokens,
      systemPrompt: input.systemPrompt,
      declarations,
    })).digest('hex'),
  }
}

export async function writeAgentContextSurface(
  path: string,
  surface: AgentContextSurface,
): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, JSON.stringify(surface), 'utf8')
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export async function readAgentContextSurface(path: string): Promise<AgentContextSurfaceReadResult> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { status: 'missing' }
    return { status: 'invalid', error: errorMessage(error) }
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    const result = agentContextSurfaceSchema.safeParse(parsed)
    if (!result.success) {
      return { status: 'invalid', error: z.prettifyError(result.error) }
    }
    return { status: 'available', surface: result.data }
  } catch (error) {
    return { status: 'invalid', error: errorMessage(error) }
  }
}

export async function classifySurfaceStatus(
  surfaceRead: AgentContextSurfaceReadResult,
  pidPath: string,
  readTextFile: ReadTextFile = async (path, encoding) => readFile(path, encoding),
  killProcess: KillProcess = (pid, signal) => process.kill(pid, signal),
): Promise<AgentContextSurfaceStatus> {
  if (surfaceRead.status !== 'available') return surfaceRead.status

  let rawPid: string
  try {
    rawPid = await readTextFile(pidPath, 'utf8')
  } catch {
    return 'last_startup'
  }

  const normalizedPid = rawPid.trim()
  if (!/^[1-9]\d*$/.test(normalizedPid)) return 'last_startup'
  const pid = Number(normalizedPid)
  if (!Number.isSafeInteger(pid) || pid !== surfaceRead.surface.pid) return 'last_startup'

  try {
    killProcess(pid, 0)
    return 'live'
  } catch (error) {
    return isNodeError(error) && error.code === 'EPERM' ? 'live' : 'last_startup'
  }
}

function buildProviderToolDeclaration(
  provider: AgentContextSurface['provider'],
  tool: Tool,
): Record<string, unknown> {
  if (provider === 'claude-code') {
    return {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: zodToToolJsonSchema(tool.schema),
    }
  }
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: zodToOpenAIStrictToolJsonSchema(tool.schema),
      strict: true,
    },
  }
}

function serializeSystemIdentity(provider: AgentContextSurface['provider']): string {
  return provider === 'claude-code'
    ? CLAUDE_CODE_BILLING_HEADER
    : JSON.stringify({ role: 'developer', content: '' })
}

function measure(serialized: string): { bytes: number; tokens: number } {
  return {
    bytes: Buffer.byteLength(serialized, 'utf8'),
    tokens: estimateUtf8Tokens(serialized),
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
    .join(',')}}`
}

function sumBigInts(values: readonly number[]): bigint {
  return values.reduce((sum, value) => sum + BigInt(value), 0n)
}

function sumSafeIntegers(values: readonly number[], label: string): number {
  const total = sumBigInts(values)
  if (total > maxSafeIntegerBigInt) {
    throw new RangeError(`${label} total exceeds Number.MAX_SAFE_INTEGER`)
  }
  return Number(total)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
