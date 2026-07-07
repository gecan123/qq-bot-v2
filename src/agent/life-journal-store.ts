import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface LifeJournalStoreOptions {
  rootDir: string
  now?: () => Date
}

const AGENDA_TEMPLATE = `# Agenda

## Active
- [ ] Keep noticing what matters now.

## Waiting

## Someday

## Done
`

function currentDate(options: LifeJournalStoreOptions): Date {
  return options.now?.() ?? new Date()
}

function shanghaiParts(date: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  }
}

function lifeDir(rootDir: string): string {
  return join(rootDir, 'life')
}

function agendaPath(rootDir: string): string {
  return join(lifeDir(rootDir), 'agenda.md')
}

function journalDir(rootDir: string): string {
  return join(lifeDir(rootDir), 'journal')
}

function journalPath(rootDir: string, date: string): string {
  return join(journalDir(rootDir), `${date}.md`)
}

export async function appendLifeJournalEntry(
  options: LifeJournalStoreOptions & { roundIndex: number; markdown: string },
): Promise<{ path: string; heading: string }> {
  const { date, time } = shanghaiParts(currentDate(options))
  const path = journalPath(options.rootDir, date)
  const heading = `## ${time} Round ${options.roundIndex}`
  const body = options.markdown.endsWith('\n') ? options.markdown : `${options.markdown}\n`

  await mkdir(journalDir(options.rootDir), { recursive: true })
  try {
    await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    await writeFile(path, `# Life Journal ${date}\n\n`, 'utf8')
  }

  await appendFile(path, `${heading}\n\n${body}\n`, 'utf8')
  return { path, heading }
}

export async function ensureLifeAgenda(options: LifeJournalStoreOptions): Promise<string> {
  const path = agendaPath(options.rootDir)
  await mkdir(lifeDir(options.rootDir), { recursive: true })
  try {
    await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    await writeFile(path, AGENDA_TEMPLATE, 'utf8')
  }
  return path
}

export async function readLifeAgenda(options: LifeJournalStoreOptions): Promise<string> {
  await ensureLifeAgenda(options)
  return readFile(agendaPath(options.rootDir), 'utf8')
}

export async function writeLifeAgenda(options: LifeJournalStoreOptions, markdown: string): Promise<void> {
  await mkdir(lifeDir(options.rootDir), { recursive: true })
  await writeFile(agendaPath(options.rootDir), markdown, 'utf8')
}

export async function readRecentLifeJournalFiles(
  options: LifeJournalStoreOptions & { days: number },
): Promise<Array<{ path: string; content: string }>> {
  let names: string[]
  try {
    names = await readdir(journalDir(options.rootDir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    return []
  }

  const dailyNames = names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, Math.max(0, options.days))

  return Promise.all(
    dailyNames.map(async (name) => {
      const path = join(journalDir(options.rootDir), name)
      return { path, content: await readFile(path, 'utf8') }
    }),
  )
}
