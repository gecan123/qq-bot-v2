import type { AgentMessage, ToolResultContent } from './agent-context.types.js'
import type { LlmClient } from './llm-client.js'
import { createLogger } from '../logger.js'
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

interface ReviewJson {
  shouldWrite?: unknown
  journalMarkdown?: unknown
  agendaMarkdown?: unknown
}

interface IdleJson {
  intention?: unknown
}

const log = createLogger('LIFE_JOURNAL')

const REVIEW_SYSTEM_PROMPT = `You are Luna writing your own Life Journal.

This is Luna's private notebook for lived continuity, not a mechanical execution log.
Write subjectively in first person when a round contains something worth remembering.
Skip mechanical tool-call logs and transient implementation chatter.

Return strict JSON only:
{
  "shouldWrite": boolean,
  "journalMarkdown": string,
  "agendaMarkdown": string
}

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
Return strict JSON only:
{
  "intention": string | null
}

Choose null unless there is a concrete, low-risk next thing Luna can do by herself.`

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) {
    throw new Error('missing JSON object')
  }
  return JSON.parse(text.slice(start, end + 1))
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
      return block
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

export function createLifeJournalRuntime(deps: {
  rootDir?: string
  llm: LlmClient
  now?: () => Date
  maxRoundChars?: number
}): LifeJournalRuntime {
  const rootDir = deps.rootDir ?? 'data/agent-workspace'
  const maxRoundChars = deps.maxRoundChars ?? 6000

  return {
    async recordRound(input) {
      try {
        await ensureLifeAgenda({ rootDir, now: deps.now })
        const output = await deps.llm.chat({
          systemPrompt: REVIEW_SYSTEM_PROMPT,
          messages: boundRoundMessages(input.messages, maxRoundChars),
          tools: [],
        })
        const parsed = extractJsonObject(output.content) as ReviewJson
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
        log.warn({ err: error }, 'life_journal_record_failed')
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
        const output = await deps.llm.chat({
          systemPrompt: IDLE_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: truncateText(`# Agenda\n${agenda}\n\n# Recent Life Journal\n${recent}`, maxRoundChars),
            },
          ],
          tools: [],
        })
        const parsed = extractJsonObject(output.content) as IdleJson
        const intention = asNonEmptyString(parsed.intention)
        return { ok: true, intention: intention || null }
      } catch (error) {
        log.warn({ err: error }, 'life_journal_idle_pick_failed')
        return {
          ok: false,
          intention: null,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
