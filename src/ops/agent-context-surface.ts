import { randomUUID } from 'node:crypto'
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
import { formatBeijingIso } from '../utils/beijing-time.js'

export const AGENT_CONTEXT_SURFACE_SCHEMA_VERSION = 2 as const
export const AGENT_CONTEXT_SURFACE_PATH = 'logs/context-surface.json'

export interface AgentContextSurface {
  schemaVersion: 2
  generatedAt: string
  provider: 'claude-code' | 'openai-agent'
  model: string
  contextWindowTokens: number
  fixedTokens: {
    systemIdentity: number
    botSystemPrompt: number
    visibleTools: number
  }
}

export type AgentContextSurfaceReadResult =
  | { status: 'available'; surface: AgentContextSurface }
  | { status: 'missing' }
  | { status: 'invalid'; error: string }

const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveSafeIntegerSchema = nonNegativeSafeIntegerSchema.positive()
const agentContextSurfaceSchema = z.object({
  schemaVersion: z.literal(AGENT_CONTEXT_SURFACE_SCHEMA_VERSION),
  generatedAt: z.iso.datetime({ offset: true }),
  provider: z.enum(['claude-code', 'openai-agent']),
  model: z.string().min(1),
  contextWindowTokens: positiveSafeIntegerSchema,
  fixedTokens: z.object({
    systemIdentity: nonNegativeSafeIntegerSchema,
    botSystemPrompt: nonNegativeSafeIntegerSchema,
    visibleTools: nonNegativeSafeIntegerSchema,
  }).strict(),
}).strict()

export function buildAgentContextSurface(input: {
  provider: 'claude-code' | 'openai-agent'
  model: string
  contextWindowTokens: number
  systemPrompt: string
  tools: Tool[]
  generatedAt: string
}): AgentContextSurface {
  const declarations = input.tools.map((tool) => buildProviderToolDeclaration(input.provider, tool))
  const visibleTools = sumSafeIntegers(
    declarations.map((declaration) => estimateUtf8Tokens(JSON.stringify(declaration))),
    'visible tool tokens',
  )

  return {
    schemaVersion: AGENT_CONTEXT_SURFACE_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    provider: input.provider,
    model: input.model,
    contextWindowTokens: input.contextWindowTokens,
    fixedTokens: {
      systemIdentity: estimateUtf8Tokens(serializeSystemIdentity(input.provider)),
      botSystemPrompt: estimateUtf8Tokens(input.systemPrompt),
      visibleTools,
    },
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

export async function writeRuntimeAgentContextSurface(input: {
  path: string
  provider: AgentContextSurface['provider']
  model: string
  contextWindowTokens: number
  systemPrompt: string
  tools: Tool[]
  now?: () => Date
}): Promise<AgentContextSurface> {
  const surface = buildAgentContextSurface({
    provider: input.provider,
    model: input.model,
    contextWindowTokens: input.contextWindowTokens,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    generatedAt: formatBeijingIso((input.now ?? (() => new Date()))()),
  })
  await writeAgentContextSurface(input.path, surface)
  return surface
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

function sumSafeIntegers(values: readonly number[], label: string): number {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) {
      throw new RangeError(`${label} total exceeds Number.MAX_SAFE_INTEGER`)
    }
  }
  return total
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
