import type { AgentMessage, ToolResultContent } from './agent-context.types.js'
import type { LlmCallInput, LlmClient } from './llm-client.js'
import type { Tool } from './tool.js'
import { createLogger } from '../logger.js'
import { z } from 'zod'
import { recordTokenUsage, type TokenUsageEntry } from './token-stats.js'
import {
  appendLifeJournalEntry,
  ensureLifeAgenda,
  readLifeAgenda,
  readRecentLifeJournalFiles,
  writeLifeAgenda,
} from './life-journal-store.js'

export interface LifeJournalRuntime {
  recordRound(input: {
    roundIndex: number
    messages: AgentMessage[]
  }): Promise<{ ok: boolean; wroteJournal: boolean; updatedAgenda: boolean; error?: string }>

  pickIdleIntention(): Promise<{ ok: boolean; intention: string | null; error?: string }>
}

const reviewResultSchema = z.object({
  shouldWrite: z.boolean(),
  journalMarkdown: z.string(),
  agendaMarkdown: z.string(),
})

type ReviewJson = z.infer<typeof reviewResultSchema>

const idleResultSchema = z.object({
  intention: z.string().nullable(),
})

type IdleJson = z.infer<typeof idleResultSchema>

const log = createLogger('LIFE_JOURNAL')
const DEFAULT_MIN_WRITE_INTERVAL_MS = 10 * 60 * 1000
const DEFAULT_REVIEW_TIMEOUT_MS = 30 * 1000
const JOURNAL_MARKER = '<<<JOURNAL>>>'
const AGENDA_MARKER = '<<<AGENDA>>>'

const REVIEW_SYSTEM_PROMPT = `You are Luna writing your own Life Journal.

This is Luna's private notebook for lived continuity, not a mechanical execution log.
Write subjectively in first person when a round contains something worth remembering.
Skip mechanical tool-call logs and transient implementation chatter.

Prefer calling life_journal_review_result exactly once.
Fields:
- shouldWrite: boolean
- journalMarkdown: string
- agendaMarkdown: string

If tool calling is unavailable, use exactly one of these plain-text fallbacks instead of prose:

SKIP

or:

RECORD
<<<JOURNAL>>>
<journal markdown, or empty>
<<<AGENDA>>>
<full agenda markdown, or empty>

Both markers are required after RECORD. Use SKIP when neither file needs an update.

Journal markdown rules:
- Use only these section headings when present: Saw, Did, Promised, I care about, Next, Mood.
- Format headings as "### Saw".
- Use 0-3 bullets per section.
- Omit empty sections.

Agenda markdown rules:
- If updating agenda, return the full file.
- Keep these sections: Active, Waiting, Someday, Done.
- Return an empty string when no agenda update is needed.`

const IDLE_SYSTEM_PROMPT = `You are Luna choosing a small idle intention from her Life Journal.

Prefer the Agenda. Use recent journal notes only as bounded context.
Call life_journal_idle_result exactly once. Do not answer with prose.
Field:
- intention: string or null

Choose null unless there is a concrete, low-risk next thing Luna can do by herself.`

const reviewResultTool: Tool<ReviewJson> = {
  name: 'life_journal_review_result',
  description: 'Return the structured Life Journal review result. Call exactly once.',
  schema: reviewResultSchema,
  async execute() {
    return { content: JSON.stringify({ ok: true }) }
  },
}

const idleResultTool: Tool<IdleJson> = {
  name: 'life_journal_idle_result',
  description: 'Return the structured Life Journal idle intention result. Call exactly once.',
  schema: idleResultSchema,
  async execute() {
    return { content: JSON.stringify({ ok: true }) }
  },
}

class JsonObjectParseError extends Error {
  readonly outputPreview: string

  constructor(message: string, output: string) {
    super(message)
    this.name = 'JsonObjectParseError'
    this.outputPreview = truncateText(output.trim() || '[empty]', 500)
  }
}

class EmptyStructuredResultError extends Error {
  constructor() {
    super('empty structured result')
    this.name = 'EmptyStructuredResultError'
  }
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) {
    throw new JsonObjectParseError('missing JSON object', text)
  }
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new JsonObjectParseError(`invalid JSON object: ${message}`, text)
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text
  }
  return `${text.slice(0, Math.max(0, maxChars))}\n[truncated]`
}

function truncateToolContent(content: ToolResultContent, maxChars: number): ToolResultContent {
  if (typeof content === 'string') {
    return truncateText(content, maxChars)
  }

  let remaining = maxChars
  return content.map((block) => {
    if (block.type !== 'text') {
      const label = `[non-text tool result omitted: image ${block.source.media_type}]`
      const text = truncateText(label, remaining)
      remaining = Math.max(0, remaining - label.length)
      return { type: 'text', text }
    }
    const text = truncateText(block.text, remaining)
    remaining = Math.max(0, remaining - block.text.length)
    return { ...block, text }
  })
}

function boundRoundMessages(messages: AgentMessage[], maxRoundChars: number): AgentMessage[] {
  let remaining = maxRoundChars
  return messages.map((message) => {
    if (message.role === 'user') {
      const content = truncateText(message.content, remaining)
      remaining = Math.max(0, remaining - message.content.length)
      return { ...message, content }
    }

    if (message.role === 'assistant') {
      const content = truncateText(message.content, remaining)
      remaining = Math.max(0, remaining - message.content.length)
      return { ...message, content }
    }

    const content = truncateToolContent(message.content, remaining)
    remaining = 0
    return { ...message, content }
  })
}

function asNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : ''
}

function parseReviewTextProtocol(text: string): ReviewJson | null {
  const trimmed = text.trim()
  if (trimmed === 'SKIP') {
    return { shouldWrite: false, journalMarkdown: '', agendaMarkdown: '' }
  }

  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline < 0 || trimmed.slice(0, firstNewline).trim() !== 'RECORD') {
    return null
  }

  const payload = trimmed.slice(firstNewline + 1)
  const journalStart = payload.indexOf(JOURNAL_MARKER)
  const agendaStart = payload.indexOf(AGENDA_MARKER)
  if (journalStart < 0 || agendaStart < journalStart + JOURNAL_MARKER.length) {
    return null
  }

  const journalMarkdown = payload
    .slice(journalStart + JOURNAL_MARKER.length, agendaStart)
    .trim()
  const agendaMarkdown = payload
    .slice(agendaStart + AGENDA_MARKER.length)
    .trim()
  if (!journalMarkdown && !agendaMarkdown) {
    return null
  }

  return {
    shouldWrite: Boolean(journalMarkdown),
    journalMarkdown,
    agendaMarkdown,
  }
}

function extractToolResultOrJson<T>(
  output: Awaited<ReturnType<LlmClient['chat']>>,
  tool: Tool<T>,
  parseText?: (text: string) => T | null,
): T {
  const call = output.toolCalls.find((candidate) => candidate.name === tool.name)
  if (call) {
    const parsed = tool.schema.safeParse(call.args)
    if (!parsed.success) {
      throw new JsonObjectParseError(
        `invalid ${tool.name} args: ${parsed.error.message}`,
        JSON.stringify(call.args),
      )
    }
    return parsed.data as T
  }

  if (!output.content.trim()) {
    throw new EmptyStructuredResultError()
  }

  const textResult = parseText?.(output.content)
  if (textResult) {
    return textResult
  }

  const json = extractJsonObject(output.content)
  const parsed = tool.schema.safeParse(json)
  if (!parsed.success) {
    throw new JsonObjectParseError(
      `invalid ${tool.name} JSON: ${parsed.error.message}`,
      output.content,
    )
  }
  return parsed.data as T
}

async function chatStructuredObject<T>(
  llm: LlmClient,
  input: LlmCallInput,
  tool: Tool<T>,
  options: {
    parseText?: (text: string) => T | null
    retryInstruction?: string
    invalidAsEmpty?: boolean
  } = {},
): Promise<T> {
  const request = { ...input, tools: [tool] }
  const output = await llm.chat(request)
  try {
    return extractToolResultOrJson(output, tool, options.parseText)
  } catch (error) {
    if (!(error instanceof JsonObjectParseError) && !(error instanceof EmptyStructuredResultError)) {
      throw error
    }
  }

  const retryOutput = await llm.chat({
    ...request,
    systemPrompt: `${input.systemPrompt}

${options.retryInstruction ?? `Your previous response did not call ${tool.name} with valid arguments. Call ${tool.name} exactly once and do not answer with prose.`}`,
  })
  try {
    return extractToolResultOrJson(retryOutput, tool, options.parseText)
  } catch (error) {
    if (!(error instanceof JsonObjectParseError) && !(error instanceof EmptyStructuredResultError)) {
      throw error
    }
    if (!options.invalidAsEmpty) {
      throw error
    }
    log.debug({
      toolName: tool.name,
      outputPreview: error instanceof JsonObjectParseError ? error.outputPreview : '[empty]',
    }, 'life_journal_structured_result_invalid_skipped')
    throw new EmptyStructuredResultError()
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        timeout.unref?.()
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export function createLifeJournalRuntime(deps: {
  rootDir?: string
  llm: LlmClient
  now?: () => Date
  maxRoundChars?: number
  minWriteIntervalMs?: number
  reviewTimeoutMs?: number
  recordUsage?: (entry: TokenUsageEntry) => void
}): LifeJournalRuntime {
  const rootDir = deps.rootDir ?? 'data/agent-workspace'
  const maxRoundChars = deps.maxRoundChars ?? 6000
  const minWriteIntervalMs = Math.max(0, deps.minWriteIntervalMs ?? DEFAULT_MIN_WRITE_INTERVAL_MS)
  const reviewTimeoutMs = Math.max(1, deps.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS)
  const recordUsage = deps.recordUsage ?? recordTokenUsage
  let lastReviewAtMs: number | null = null

  return {
    async recordRound(input) {
      try {
        const nowMs = (deps.now?.() ?? new Date()).getTime()
        if (lastReviewAtMs != null && nowMs - lastReviewAtMs < minWriteIntervalMs) {
          log.debug({ roundIndex: input.roundIndex, minWriteIntervalMs }, 'life_journal_review_throttled')
          return { ok: true, wroteJournal: false, updatedAgenda: false }
        }

        await ensureLifeAgenda({ rootDir, now: deps.now })
        lastReviewAtMs = nowMs
        const reviewLlm: LlmClient = {
          async chat(chatInput) {
            const output = await withTimeout(
              deps.llm.chat(chatInput),
              reviewTimeoutMs,
              'life journal review',
            )
            try {
              recordUsage({
                operation: 'life_journal.review',
                roundIndex: input.roundIndex,
                inputTokens: output.usage.inputTokens,
                cachedTokens: output.usage.cachedTokens,
                outputTokens: output.usage.outputTokens,
                model: output.model,
              })
            } catch (error) {
              log.warn({ err: error }, 'life_journal_usage_record_failed')
            }
            return output
          },
        }
        const parsed = await chatStructuredObject<ReviewJson>(reviewLlm, {
          systemPrompt: REVIEW_SYSTEM_PROMPT,
          messages: boundRoundMessages(input.messages, maxRoundChars),
          tools: [],
        }, reviewResultTool, {
          parseText: parseReviewTextProtocol,
          retryInstruction: `Your previous response was invalid. Either call life_journal_review_result exactly once or follow the SKIP/RECORD fallback protocol exactly. Do not answer with prose.`,
          invalidAsEmpty: true,
        })
        const journalMarkdown = asNonEmptyString(parsed.journalMarkdown)
        const agendaMarkdown = asNonEmptyString(parsed.agendaMarkdown)
        const shouldWrite = parsed.shouldWrite === true

        let wroteJournal = false
        let updatedAgenda = false
        if (shouldWrite && journalMarkdown) {
          await appendLifeJournalEntry({
            rootDir,
            now: deps.now,
            roundIndex: input.roundIndex,
            markdown: journalMarkdown,
          })
          wroteJournal = true
        }
        if (agendaMarkdown) {
          await writeLifeAgenda({ rootDir, now: deps.now }, agendaMarkdown)
          updatedAgenda = true
        }

        return { ok: true, wroteJournal, updatedAgenda }
      } catch (error) {
        if (error instanceof EmptyStructuredResultError) {
          log.debug({ roundIndex: input.roundIndex }, 'life_journal_record_empty_skipped')
          return { ok: true, wroteJournal: false, updatedAgenda: false }
        }
        log.warn({
          err: error,
          outputPreview: error instanceof JsonObjectParseError ? error.outputPreview : undefined,
        }, 'life_journal_record_failed')
        return {
          ok: false,
          wroteJournal: false,
          updatedAgenda: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },

    async pickIdleIntention() {
      try {
        const agenda = await readLifeAgenda({ rootDir, now: deps.now })
        const recentFiles = await readRecentLifeJournalFiles({ rootDir, now: deps.now, days: 2 })
        const recent = recentFiles
          .map((file) => `## ${file.path}\n${truncateText(file.content, 2000)}`)
          .join('\n\n')
        const parsed = await chatStructuredObject<IdleJson>(deps.llm, {
          systemPrompt: IDLE_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: truncateText(`# Agenda\n${agenda}\n\n# Recent Life Journal\n${recent}`, maxRoundChars),
            },
          ],
          tools: [],
        }, idleResultTool)
        const intention = asNonEmptyString(parsed.intention)
        return { ok: true, intention: intention || null }
      } catch (error) {
        if (error instanceof EmptyStructuredResultError) {
          log.debug('life_journal_idle_pick_empty_skipped')
          return { ok: true, intention: null }
        }
        log.warn({
          err: error,
          outputPreview: error instanceof JsonObjectParseError ? error.outputPreview : undefined,
        }, 'life_journal_idle_pick_failed')
        return {
          ok: false,
          intention: null,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
