import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { createLogger } from '../logger.js'
import { summarizeToolArgs } from '../ops/tool-call-log.js'
import type { AssistantToolCall } from './agent-context.types.js'
import type { ToolExecutionResult, ToolExecutor } from './tool.js'

const log = createLogger('AGENT_ACTIVITY_SURFACE')
const jsonValueSchema = z.json()

export const AGENT_ACTIVITY_SURFACE_PATH = 'logs/agent-activity.json'

const phaseSchema = z.enum([
  'starting',
  'thinking',
  'tool',
  'resting',
  'committing',
  'waiting',
  'error',
  'stopping',
  'stopped',
])

const targetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('group'), id: z.string().regex(/^\d+$/) }).strict(),
  z.object({ type: z.literal('private'), id: z.string().regex(/^\d+$/) }).strict(),
])

const triggerSchema = z.object({
  kind: z.enum([
    'private_message',
    'group_mention',
    'scheduled_wake',
    'background_task',
    'bootstrap',
    'goal',
    'manual_wake',
  ]),
  label: z.string().min(1).max(500),
  target: targetSchema.nullable(),
}).strict()

const activeToolSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  roundIndex: z.number().int().nonnegative(),
  startedAt: z.iso.datetime({ offset: true }),
  argsSummary: jsonValueSchema,
}).strict()

const completedToolSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  roundIndex: z.number().int().nonnegative(),
  at: z.iso.datetime({ offset: true }),
  durationMs: z.number().int().nonnegative(),
  ok: z.boolean(),
  error: z.string().max(1_000).nullable(),
}).strict()

export const agentActivitySurfaceSchema = z.object({
  schemaVersion: z.literal(1),
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.iso.datetime({ offset: true }),
  generatedAt: z.iso.datetime({ offset: true }),
  phase: phaseSchema,
  phaseStartedAt: z.iso.datetime({ offset: true }),
  roundIndex: z.number().int().nonnegative().nullable(),
  detail: z.string().max(1_000).nullable(),
  waitUntil: z.iso.datetime({ offset: true }).nullable(),
  trigger: triggerSchema.nullable(),
  activeTools: z.array(activeToolSchema).max(32),
  lastCompleted: completedToolSchema.nullable(),
}).strict()

export type AgentActivitySurface = z.infer<typeof agentActivitySurfaceSchema>
export type AgentActivityPhase = z.infer<typeof phaseSchema>
export type AgentActivityTrigger = z.infer<typeof triggerSchema>

export interface AgentActivityReporter {
  setTrigger(trigger: AgentActivityTrigger | null): void
  setPhase(input: {
    phase: AgentActivityPhase
    roundIndex?: number | null
    detail?: string | null
    waitUntil?: string | null
  }): void
  toolStarted(input: {
    toolCallId: string
    toolName: string
    roundIndex: number
    argsSummary: unknown
  }): void
  toolFinished(input: {
    toolCallId: string
    ok: boolean
    error?: string | null
  }): void
  flush(): Promise<void>
}

interface ReporterOptions {
  path?: string
  pid?: number
  instanceId?: string
  now?: () => Date
  write?: (path: string, surface: AgentActivitySurface) => Promise<void>
}

export function createAgentActivityReporter(options: ReporterOptions = {}): AgentActivityReporter {
  const path = options.path ?? AGENT_ACTIVITY_SURFACE_PATH
  const pid = options.pid ?? process.pid
  const instanceId = options.instanceId ?? randomUUID()
  const now = options.now ?? (() => new Date())
  const write = options.write ?? writeAgentActivitySurface
  const createdAt = now().toISOString()
  let surface: AgentActivitySurface = {
    schemaVersion: 1,
    instanceId,
    pid,
    startedAt: createdAt,
    generatedAt: createdAt,
    phase: 'starting',
    phaseStartedAt: createdAt,
    roundIndex: null,
    detail: null,
    waitUntil: null,
    trigger: null,
    activeTools: [],
    lastCompleted: null,
  }
  let writeTail: Promise<void> = Promise.resolve()

  const publish = (): void => {
    const snapshot = agentActivitySurfaceSchema.parse(structuredClone(surface))
    writeTail = writeTail
      .then(() => write(path, snapshot))
      .catch((error: unknown) => {
        log.warn({ error, path }, 'agent_activity_surface_write_failed')
      })
  }

  publish()

  return {
    setTrigger(trigger) {
      surface = { ...surface, trigger, generatedAt: now().toISOString() }
      publish()
    },
    setPhase(input) {
      const at = now().toISOString()
      surface = {
        ...surface,
        phase: input.phase,
        phaseStartedAt: input.phase === surface.phase ? surface.phaseStartedAt : at,
        generatedAt: at,
        roundIndex: input.roundIndex === undefined ? surface.roundIndex : input.roundIndex,
        detail: input.detail ?? null,
        waitUntil: input.waitUntil ?? null,
      }
      publish()
    },
    toolStarted(input) {
      const at = now().toISOString()
      const activeTools = [
        ...surface.activeTools.filter(tool => tool.toolCallId !== input.toolCallId),
        { ...input, argsSummary: jsonValueSchema.parse(input.argsSummary), startedAt: at },
      ]
      const resting = input.toolName === 'pause'
      const restArgs = resting && input.argsSummary && typeof input.argsSummary === 'object'
        ? input.argsSummary as Record<string, unknown>
        : null
      const durationSeconds = typeof restArgs?.durationSeconds === 'number'
        ? restArgs.durationSeconds
        : null
      surface = {
        ...surface,
        generatedAt: at,
        phase: resting ? 'resting' : 'tool',
        phaseStartedAt: surface.activeTools.length === 0 ? at : surface.phaseStartedAt,
        roundIndex: input.roundIndex,
        detail: resting && typeof restArgs?.reason === 'string'
          ? restArgs.reason
          : `正在执行 ${input.toolName}`,
        waitUntil: durationSeconds === null
          ? null
          : new Date(now().getTime() + durationSeconds * 1_000).toISOString(),
        activeTools,
      }
      publish()
    },
    toolFinished(input) {
      const atDate = now()
      const at = atDate.toISOString()
      const completed = surface.activeTools.find(tool => tool.toolCallId === input.toolCallId)
      const activeTools = surface.activeTools.filter(tool => tool.toolCallId !== input.toolCallId)
      surface = {
        ...surface,
        generatedAt: at,
        phase: activeTools.length > 0
          ? activeTools.some(tool => tool.toolName === 'pause')
            ? 'resting'
            : 'tool'
          : 'thinking',
        phaseStartedAt: activeTools.length > 0 ? surface.phaseStartedAt : at,
        detail: activeTools.length > 0 ? surface.detail : '正在根据工具结果决定下一步',
        waitUntil: activeTools.length > 0 ? surface.waitUntil : null,
        activeTools,
        lastCompleted: completed
          ? {
              toolCallId: completed.toolCallId,
              toolName: completed.toolName,
              roundIndex: completed.roundIndex,
              at,
              durationMs: Math.max(0, atDate.getTime() - Date.parse(completed.startedAt)),
              ok: input.ok,
              error: input.error?.slice(0, 1_000) ?? null,
            }
          : surface.lastCompleted,
      }
      publish()
    },
    async flush() {
      await writeTail
    },
  }
}

export function createActivityTrackingToolExecutor(
  executor: ToolExecutor,
  reporter: AgentActivityReporter,
): ToolExecutor {
  return {
    list: () => executor.list(),
    classify: call => executor.classify(call),
    async execute(call, ctx) {
      const toolName = effectiveToolName(call)
      reporter.toolStarted({
        toolCallId: call.id,
        toolName,
        roundIndex: ctx.roundIndex,
        argsSummary: summarizeToolArgs(effectiveToolArgs(call)),
      })
      try {
        const result = await executor.execute(call, ctx)
        const completion = classifyResult(result)
        reporter.toolFinished({ toolCallId: call.id, ...completion })
        return result
      } catch (error) {
        reporter.toolFinished({
          toolCallId: call.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
  }
}

export type AgentActivitySurfaceReadResult =
  | { status: 'available'; surface: AgentActivitySurface }
  | { status: 'missing' }
  | { status: 'invalid'; error: string }

export async function readAgentActivitySurface(path: string): Promise<AgentActivitySurfaceReadResult> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { status: 'missing' }
    return { status: 'invalid', error: errorMessage(error) }
  }
  try {
    const parsed = agentActivitySurfaceSchema.safeParse(JSON.parse(raw) as unknown)
    return parsed.success
      ? { status: 'available', surface: parsed.data }
      : { status: 'invalid', error: z.prettifyError(parsed.error) }
  } catch (error) {
    return { status: 'invalid', error: errorMessage(error) }
  }
}

async function writeAgentActivitySurface(path: string, surface: AgentActivitySurface): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(surface)}\n`, 'utf8')
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

function effectiveToolName(call: AssistantToolCall): string {
  return call.name === 'invoke' && typeof call.args.tool === 'string' && call.args.tool.trim()
    ? call.args.tool.trim()
    : call.name
}

function effectiveToolArgs(call: AssistantToolCall): Record<string, unknown> {
  return call.name === 'invoke' && call.args.args && typeof call.args.args === 'object' && !Array.isArray(call.args.args)
    ? call.args.args as Record<string, unknown>
    : call.args
}

function classifyResult(result: ToolExecutionResult): { ok: boolean; error?: string } {
  if (result.outcome) {
    return result.outcome.ok
      ? { ok: true }
      : { ok: false, ...(result.outcome.error ? { error: result.outcome.error } : {}) }
  }
  if (typeof result.content !== 'string') return { ok: true }
  try {
    const parsed = JSON.parse(result.content) as unknown
    if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
      const record = parsed as Record<string, unknown>
      if (record.ok === false) {
        return { ok: false, ...(typeof record.error === 'string' ? { error: record.error } : {}) }
      }
    }
  } catch {
    // Plain text is a normal successful tool result.
  }
  return { ok: true }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
