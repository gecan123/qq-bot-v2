# Markdown Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the DB-backed person/group-only `memory` tool with a local Markdown memory library that supports `self`, `person`, `group`, and `topic` scopes.

**Architecture:** Add a focused file-backed memory store under `src/agent/memory-store.ts`, then make `src/agent/tools/memory.ts` call that store directly. Generated memory files live under `data/agent-workspace/memory/` and enter `AgentContext` only through bounded tool results.

**Tech Stack:** TypeScript ESM, Node `fs/promises`, Node `path`, Node built-in test runner, Zod 4, existing `Tool` interface.

---

## File Structure

- Create `src/agent/memory-store.ts`
  - Owns all Markdown memory file IO.
  - Parses and writes minimal frontmatter without adding a dependency.
  - Exposes `writeMemoryEntry`, `searchMemoryEntries`, and `readMemoryFile`.
  - Rejects path escapes and caps tool-visible text.
- Create `src/agent/memory-store.test.ts`
  - Tests store behavior using `mkdtemp` workspaces.
- Modify `src/agent/tools/memory.ts`
  - Defines the new `memory` schema.
  - Calls `memory-store` instead of `rememberTool` / `recallTool`.
  - Keeps `action=write` and `action=search`, adds `action=read`.
- Create `src/agent/tools/memory.test.ts`
  - Tests tool schema and behavior at the tool boundary.
- Modify `src/agent/tools/merged-tools.test.ts`
  - Update the current DB-backed memory test to file-backed behavior.
- Delete `src/agent/tools/remember.ts`, `src/agent/tools/recall.ts`, `src/agent/tools/remember.test.ts`, and `src/agent/tools/recall.test.ts`
  - They are no longer part of the runtime memory path.
- Modify `docs/TOOLS.md`, `prompts/bot-system.md`, and `docs/agent-skills/memory_hygiene.md`
  - Document the new memory semantics.
- Modify `src/ops/repo-check.test.ts` only if prompt/doc assertions need their expected fixture strings updated.

Do not stage unrelated existing worktree changes. Each commit command below must stage only the paths named in that task.

---

### Task 1: Add the Markdown Memory Store

**Files:**
- Create: `src/agent/memory-store.ts`
- Create: `src/agent/memory-store.test.ts`

- [ ] **Step 1: Write failing store tests**

Create `src/agent/memory-store.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readMemoryFile,
  searchMemoryEntries,
  writeMemoryEntry,
} from './memory-store.js'

async function withTempMemory<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), 'memory-store-'))
  try {
    return await fn(rootDir)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

describe('memory-store', () => {
  test('writes self memory to a markdown file with frontmatter', async () => {
    await withTempMemory(async (rootDir) => {
      const result = await writeMemoryEntry({
        rootDir,
        now: () => new Date('2026-06-27T00:00:00.000Z'),
      }, {
        scope: 'self',
        title: 'working-notes',
        content: '以后做本地记忆优先保持 tool result 有上限',
      })

      assert.equal(result.ok, true)
      assert.equal(result.file, 'self/working-notes.md')

      const raw = await readFile(join(rootDir, 'memory', 'self', 'working-notes.md'), 'utf8')
      assert.match(raw, /scope: self/)
      assert.match(raw, /title: working-notes/)
      assert.match(raw, /updatedAt: 2026-06-27T00:00:00.000Z/)
      assert.match(raw, /- 2026-06-27T00:00:00.000Z: 以后做本地记忆优先保持 tool result 有上限/)
    })
  })

  test('writes person, group, and topic memories to scoped files', async () => {
    await withTempMemory(async (rootDir) => {
      const now = () => new Date('2026-06-27T00:00:00.000Z')
      const person = await writeMemoryEntry({ rootDir, now }, {
        scope: 'person',
        id: '12345',
        content: '喜欢短句',
      })
      const group = await writeMemoryEntry({ rootDir, now }, {
        scope: 'group',
        id: '98765',
        content: '这个群聊 AI 工具很多',
      })
      const topic = await writeMemoryEntry({ rootDir, now }, {
        scope: 'topic',
        title: 'qq-bot-v2',
        content: 'memory 改成本地 Markdown',
      })

      assert.equal(person.file, 'people/12345.md')
      assert.equal(group.file, 'groups/98765.md')
      assert.equal(topic.file, 'topics/qq-bot-v2.md')
    })
  })

  test('search returns bounded snippets across scopes', async () => {
    await withTempMemory(async (rootDir) => {
      const now = () => new Date('2026-06-27T00:00:00.000Z')
      await writeMemoryEntry({ rootDir, now }, {
        scope: 'self',
        title: 'working-notes',
        content: 'Markdown memory keeps replay deterministic',
      })
      await writeMemoryEntry({ rootDir, now }, {
        scope: 'topic',
        title: 'browser-sidecar',
        content: 'browser screenshots should stay bounded',
      })

      const result = await searchMemoryEntries({ rootDir }, {
        keyword: 'memory',
        limit: 5,
      })

      assert.equal(result.ok, true)
      assert.equal(result.matches.length, 1)
      assert.equal(result.matches[0]!.file, 'self/working-notes.md')
      assert.equal(result.matches[0]!.scope, 'self')
      assert.match(result.matches[0]!.snippet, /Markdown memory/)
      assert.equal(result.skippedCorrupt, 0)
    })
  })

  test('read caps oversized markdown content', async () => {
    await withTempMemory(async (rootDir) => {
      await writeMemoryEntry({ rootDir, maxReadChars: 80 }, {
        scope: 'self',
        title: 'working-notes',
        content: 'x'.repeat(200),
      })

      const result = await readMemoryFile({ rootDir, maxReadChars: 80 }, {
        file: 'self/working-notes.md',
      })

      assert.equal(result.ok, true)
      assert.equal(result.truncated, true)
      assert.ok(result.content.length <= 120)
      assert.match(result.content, /truncated/)
    })
  })

  test('search skips corrupt frontmatter and reports skippedCorrupt', async () => {
    await withTempMemory(async (rootDir) => {
      await mkdir(join(rootDir, 'memory', 'self'), { recursive: true })
      await writeFile(join(rootDir, 'memory', 'self', 'bad.md'), '---\nscope self\n---\nhello memory\n', 'utf8')
      await writeMemoryEntry({ rootDir }, {
        scope: 'self',
        title: 'good',
        content: 'hello memory',
      })

      const result = await searchMemoryEntries({ rootDir }, { keyword: 'memory' })

      assert.equal(result.ok, true)
      assert.equal(result.skippedCorrupt, 1)
      assert.deepEqual(result.matches.map((match) => match.file), ['self/good.md'])
    })
  })

  test('read rejects path escapes', async () => {
    await withTempMemory(async (rootDir) => {
      const result = await readMemoryFile({ rootDir }, { file: '../secret.md' })

      assert.equal(result.ok, false)
      assert.match(result.error, /not allowed/)
    })
  })
})
```

- [ ] **Step 2: Run store tests and verify they fail**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/memory-store.test.ts
```

Expected: FAIL because `src/agent/memory-store.ts` does not exist.

- [ ] **Step 3: Implement the store**

Create `src/agent/memory-store.ts` with these exports and behavior:

```ts
import { mkdir, readFile, readdir, appendFile, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, resolve } from 'node:path'

export type MemoryScope = 'self' | 'person' | 'group' | 'topic'

export interface MemoryStoreOptions {
  rootDir: string
  now?: () => Date
  maxReadChars?: number
  maxSnippetChars?: number
}

export interface WriteMemoryInput {
  scope: MemoryScope
  id?: string
  title?: string
  content: string
  sourceMessageIds?: number[]
}

export interface SearchMemoryInput {
  keyword?: string
  scope?: MemoryScope
  limit?: number
}

export interface ReadMemoryInput {
  file: string
}

export interface MemoryWriteResult {
  ok: true
  file: string
  scope: MemoryScope
  title: string
}

export interface MemorySearchMatch {
  file: string
  scope: MemoryScope
  title: string
  updatedAt: string | null
  snippet: string
}

export interface MemorySearchResult {
  ok: true
  matches: MemorySearchMatch[]
  skippedCorrupt: number
}

export type MemoryReadResult =
  | { ok: true; file: string; content: string; truncated: boolean }
  | { ok: false; error: string }

const DEFAULT_MAX_READ_CHARS = 4_000
const DEFAULT_MAX_SNIPPET_CHARS = 240
const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 20

export async function writeMemoryEntry(
  options: MemoryStoreOptions,
  input: WriteMemoryInput,
): Promise<MemoryWriteResult> {
  const now = options.now?.() ?? new Date()
  const relativeFile = fileForInput(input)
  const absoluteFile = safeMemoryFile(options.rootDir, relativeFile)
  await mkdir(dirname(absoluteFile), { recursive: true })

  const title = titleForInput(input)
  const existing = await readOptional(absoluteFile)
  if (existing == null) {
    const initial = renderNewFile(input.scope, title, now.toISOString())
    await writeFile(absoluteFile, initial, 'utf8')
  } else {
    const updated = replaceUpdatedAt(existing, now.toISOString())
    if (updated !== existing) await writeFile(absoluteFile, updated, 'utf8')
  }

  await appendFile(absoluteFile, renderBullet(now, input), 'utf8')
  return { ok: true, file: relativeFile, scope: input.scope, title }
}

export async function searchMemoryEntries(
  options: MemoryStoreOptions,
  input: SearchMemoryInput = {},
): Promise<MemorySearchResult> {
  const root = memoryRoot(options.rootDir)
  const files = await listMarkdownFiles(root)
  const needle = input.keyword?.trim().toLocaleLowerCase()
  const limit = Math.min(input.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
  const matches: MemorySearchMatch[] = []
  let skippedCorrupt = 0

  for (const file of files) {
    const raw = await readFile(join(root, file), 'utf8')
    const parsed = parseMarkdownMemory(raw)
    if (!parsed) {
      skippedCorrupt += 1
      continue
    }
    if (input.scope && parsed.scope !== input.scope) continue
    const haystack = `${file}\n${parsed.title}\n${raw}`.toLocaleLowerCase()
    if (needle && !haystack.includes(needle)) continue
    matches.push({
      file,
      scope: parsed.scope,
      title: parsed.title,
      updatedAt: parsed.updatedAt,
      snippet: snippetFor(raw, needle ?? '', options.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS),
    })
  }

  matches.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.file.localeCompare(b.file))
  return { ok: true, matches: matches.slice(0, limit), skippedCorrupt }
}

export async function readMemoryFile(
  options: MemoryStoreOptions,
  input: ReadMemoryInput,
): Promise<MemoryReadResult> {
  let absoluteFile: string
  try {
    absoluteFile = safeMemoryFile(options.rootDir, input.file)
  } catch {
    return { ok: false, error: 'memory file is not allowed' }
  }

  let raw: string
  try {
    raw = await readFile(absoluteFile, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { ok: false, error: 'memory file not found' }
    }
    throw err
  }

  const max = options.maxReadChars ?? DEFAULT_MAX_READ_CHARS
  if (raw.length <= max) return { ok: true, file: input.file, content: raw, truncated: false }
  return {
    ok: true,
    file: input.file,
    content: `${raw.slice(0, max)}\n[...truncated at ${max} chars]`,
    truncated: true,
  }
}
```

Then add private helpers in the same file:

```ts
function memoryRoot(rootDir: string): string {
  return join(rootDir, 'memory')
}

function slug(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled'
}

function titleForInput(input: WriteMemoryInput): string {
  if (input.title?.trim()) return input.title.trim()
  if (input.id?.trim()) return input.id.trim()
  if (input.scope === 'self') return 'working-notes'
  return input.scope
}

function fileForInput(input: WriteMemoryInput): string {
  if (input.scope === 'person') return `people/${requiredId(input)}.md`
  if (input.scope === 'group') return `groups/${requiredId(input)}.md`
  if (input.scope === 'topic') return `topics/${slug(titleForInput(input))}.md`
  return `self/${slug(titleForInput(input))}.md`
}

function requiredId(input: WriteMemoryInput): string {
  const value = input.id?.trim()
  if (!value) throw new Error(`${input.scope} memory requires id`)
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${input.scope} id is invalid`)
  return value
}

function safeMemoryFile(rootDir: string, relativeFile: string): string {
  const normalized = normalize(relativeFile).replace(/\\/g, '/')
  if (!normalized.endsWith('.md') || normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
    throw new Error(`memory file is not allowed: ${relativeFile}`)
  }
  const root = resolve(memoryRoot(rootDir))
  const resolved = resolve(root, normalized)
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`memory file escapes root: ${relativeFile}`)
  }
  return resolved
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

function renderNewFile(scope: MemoryScope, title: string, updatedAt: string): string {
  return [
    '---',
    `scope: ${scope}`,
    `title: ${title}`,
    `updatedAt: ${updatedAt}`,
    'aliases: []',
    '---',
    '',
    '## 稳定记忆',
    '',
    '## 最近线索',
    '',
  ].join('\n')
}

function replaceUpdatedAt(raw: string, updatedAt: string): string {
  if (!raw.startsWith('---\n')) return raw
  if (/^updatedAt: .+$/m.test(raw)) return raw.replace(/^updatedAt: .+$/m, `updatedAt: ${updatedAt}`)
  return raw.replace(/^---\n/, `---\nupdatedAt: ${updatedAt}\n`)
}

function renderBullet(now: Date, input: WriteMemoryInput): string {
  const suffix = input.sourceMessageIds?.length
    ? ` (sourceMessageIds: ${input.sourceMessageIds.join(',')})`
    : ''
  return `- ${now.toISOString()}: ${input.content.trim()}${suffix}\n`
}

function parseMarkdownMemory(raw: string): { scope: MemoryScope; title: string; updatedAt: string | null } | null {
  if (!raw.startsWith('---\n')) return null
  const end = raw.indexOf('\n---\n', 4)
  if (end < 0) return null
  const frontmatter = raw.slice(4, end).split('\n')
  const record: Record<string, string> = {}
  for (const line of frontmatter) {
    if (!line.trim()) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!match) return null
    record[match[1]!] = match[2]!
  }
  if (!isMemoryScope(record.scope)) return null
  return {
    scope: record.scope,
    title: record.title || 'untitled',
    updatedAt: record.updatedAt || null,
  }
}

function isMemoryScope(value: string | undefined): value is MemoryScope {
  return value === 'self' || value === 'person' || value === 'group' || value === 'topic'
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const result: string[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(join(dir, entry.name), relative)
        else if (entry.isFile() && entry.name.endsWith('.md')) result.push(relative)
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return
      throw err
    }
  }
  await walk(root, '')
  return result.sort()
}

function snippetFor(raw: string, needle: string, maxChars: number): string {
  const bodyStart = raw.indexOf('\n---\n') >= 0 ? raw.indexOf('\n---\n') + 5 : 0
  const body = raw.slice(bodyStart).replace(/\s+/g, ' ').trim()
  const lower = body.toLocaleLowerCase()
  const idx = needle ? lower.indexOf(needle) : 0
  const start = Math.max(0, idx - 60)
  const snippet = body.slice(start, start + maxChars)
  return `${start > 0 ? '...' : ''}${snippet}${start + maxChars < body.length ? '...' : ''}`
}
```

- [ ] **Step 4: Run store tests and verify they pass**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/memory-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit store**

Run:

```bash
git add src/agent/memory-store.ts src/agent/memory-store.test.ts
git commit -m "feat: 增加 Markdown 记忆存储"
```

---

### Task 2: Move the Memory Tool to the File Store

**Files:**
- Modify: `src/agent/tools/memory.ts`
- Create: `src/agent/tools/memory.test.ts`
- Modify: `src/agent/tools/merged-tools.test.ts`

- [ ] **Step 1: Write failing tool tests**

Create `src/agent/tools/memory.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zod from 'zod'
import { createMemoryTool, memoryTool } from './memory.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

async function withTempMemory<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), 'memory-tool-'))
  try {
    return await fn(rootDir)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

describe('memory tool schema', () => {
  test('accepts self write without target id', () => {
    const parsed = memoryTool.schema.safeParse({
      action: 'write',
      scope: 'self',
      title: 'working-notes',
      content: '做本地记忆要保持输出有上限',
    })
    assert.equal(parsed.success, true)
  })

  test('accepts person write with id', () => {
    const parsed = memoryTool.schema.safeParse({
      action: 'write',
      scope: 'person',
      id: 12345,
      content: '喜欢短句',
    })
    assert.equal(parsed.success, true)
  })

  test('rejects empty content', () => {
    const parsed = memoryTool.schema.safeParse({
      action: 'write',
      scope: 'self',
      content: '',
    })
    assert.equal(parsed.success, false)
  })

  test('schema serializes cleanly to JSON Schema', () => {
    assert.doesNotThrow(() => zod.toJSONSchema(memoryTool.schema))
  })
})

describe('memory tool execute', () => {
  test('writes, searches, and reads self memory from the configured root', async () => {
    await withTempMemory(async (workspaceDir) => {
      const tool = createMemoryTool({
        workspaceDir,
        now: () => new Date('2026-06-27T00:00:00.000Z'),
      })

      const written = JSON.parse((await tool.execute({
        action: 'write',
        scope: 'self',
        title: 'working-notes',
        content: 'Markdown memory keeps replay deterministic',
      }, makeCtx())).content as string) as { ok: boolean; file: string }
      assert.equal(written.ok, true)
      assert.equal(written.file, 'self/working-notes.md')

      const searched = JSON.parse((await tool.execute({
        action: 'search',
        keyword: 'replay',
        limit: 5,
      }, makeCtx())).content as string) as { ok: boolean; matches: { file: string; snippet: string }[] }
      assert.equal(searched.ok, true)
      assert.equal(searched.matches[0]!.file, 'self/working-notes.md')
      assert.match(searched.matches[0]!.snippet, /replay/)

      const read = JSON.parse((await tool.execute({
        action: 'read',
        file: 'self/working-notes.md',
      }, makeCtx())).content as string) as { ok: boolean; content: string }
      assert.equal(read.ok, true)
      assert.match(read.content, /Markdown memory keeps replay deterministic/)
    })
  })

  test('returns structured error when person write omits id', async () => {
    await withTempMemory(async (workspaceDir) => {
      const tool = createMemoryTool({ workspaceDir })
      const result = JSON.parse((await tool.execute({
        action: 'write',
        scope: 'person',
        content: '缺 id 不应该写入',
      }, makeCtx())).content as string) as { ok: boolean; error: string }

      assert.equal(result.ok, false)
      assert.match(result.error, /requires id/)
    })
  })
})
```

Modify the existing memory test in `src/agent/tools/merged-tools.test.ts` so it no longer mocks Prisma:

```ts
  test('memory action=write/search/read uses markdown-backed memory store', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'merged-memory-'))
    try {
      const tool = createMemoryTool({
        workspaceDir: workspace,
        now: () => new Date('2026-06-27T00:00:00.000Z'),
      })

      const written = JSON.parse((await tool.execute({
        action: 'write',
        scope: 'self',
        title: 'working-notes',
        content: '喜欢冷笑话',
      }, makeCtx())).content as string) as { ok: boolean; file: string }
      const recalled = JSON.parse((await tool.execute({
        action: 'search',
        keyword: '冷笑话',
      }, makeCtx())).content as string) as { matches: { file: string; snippet: string }[] }
      const read = JSON.parse((await tool.execute({
        action: 'read',
        file: written.file,
      }, makeCtx())).content as string) as { ok: boolean; content: string }

      assert.equal(written.ok, true)
      assert.equal(recalled.matches[0]!.file, 'self/working-notes.md')
      assert.match(read.content, /喜欢冷笑话/)
      assert.doesNotThrow(() => zod.toJSONSchema(memoryTool.schema))
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
```

Also add these imports to `src/agent/tools/merged-tools.test.ts` if they are not already present:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryTool } from './memory.js'
```

- [ ] **Step 2: Run tool tests and verify they fail**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/tools/memory.test.ts src/agent/tools/merged-tools.test.ts
```

Expected: FAIL because `createMemoryTool` and the new schema are not implemented.

- [ ] **Step 3: Replace `memory.ts` implementation**

Replace `src/agent/tools/memory.ts` with:

```ts
import { z } from 'zod'
import type { Tool } from '../tool.js'
import {
  readMemoryFile,
  searchMemoryEntries,
  writeMemoryEntry,
  type MemoryScope,
} from '../memory-store.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_MEMORY')

const DEFAULT_WORKSPACE_DIR = 'data/agent-workspace'

const scopeSchema = z.enum(['self', 'person', 'group', 'topic'])
const idSchema = z.union([z.string(), z.number()])

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('write').describe('写入一条长期记忆.'),
    scope: scopeSchema.describe('记忆范围: self=自己做事/经验, person=某个 QQ 用户, group=某个群, topic=某个主题.'),
    id: idSchema.optional().describe('person/group 需要: QQ 号或群号. topic/self 通常不需要.'),
    title: z.string().trim().min(1).max(80).optional().describe('self/topic 可选: 文件主题标题.'),
    content: z.string().trim().min(1).max(500).describe('要记下来的内容. ≤500 字, 用自己的话写, 一条记一件事.'),
    sourceMessageIds: z.array(z.number().int()).optional().describe('可选: 来源 Message.id 列表, 仅供人工排查.'),
  }),
  z.object({
    action: z.literal('search').describe('搜索长期记忆.'),
    scope: scopeSchema.optional().describe('可选: 限定搜索范围.'),
    keyword: z.string().trim().min(1).max(100).optional().describe('可选: 关键词. 不传则按更新时间返回最近文件摘要.'),
    limit: z.number().int().min(1).max(20).optional().describe('可选: 最多返回多少条 (1-20, 默认 10).'),
  }),
  z.object({
    action: z.literal('read').describe('读取某个记忆文件.'),
    file: z.string().trim().min(1).max(200).describe('search/write 返回的相对文件路径, 例如 self/working-notes.md.'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface MemoryToolDeps {
  workspaceDir?: string
  now?: () => Date
}

export function createMemoryTool(deps: MemoryToolDeps = {}): Tool<Args> {
  const workspaceDir = deps.workspaceDir ?? DEFAULT_WORKSPACE_DIR

  return {
    name: 'memory',
    description: [
      '本地 Markdown 长期记忆库, 一个入口用 action 决定动作.',
      'action=write: 写入以后可能用得上的真实信息或经验; scope=self/person/group/topic.',
      'action=search: 搜索自己、人物、群或主题记忆; 不确定旧事、偏好、项目线索或自己做过什么时先查.',
      'action=read: 读取 search/write 返回的某个记忆文件; 只在需要深读时使用.',
      'person/group 写入需要 id; self/topic 可用 title 表示主题.',
      '写入要用自己的话, 不要照搬原话; 查询结果用于自然说话, 不要像报数据库.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        if (args.action === 'write') {
          const result = await writeMemoryEntry(
            { rootDir: workspaceDir, now: deps.now },
            {
              scope: args.scope as MemoryScope,
              id: args.id == null ? undefined : String(args.id),
              title: args.title,
              content: args.content,
              sourceMessageIds: args.sourceMessageIds,
            },
          )
          log.info({
            file: result.file,
            scope: result.scope,
            title: result.title,
            contentLength: args.content.length,
            sourceCount: args.sourceMessageIds?.length ?? 0,
          }, 'memory_written')
          return { content: JSON.stringify(result) }
        }

        if (args.action === 'search') {
          const result = await searchMemoryEntries(
            { rootDir: workspaceDir },
            { scope: args.scope, keyword: args.keyword, limit: args.limit },
          )
          log.info({
            scope: args.scope ?? null,
            keyword: args.keyword ?? null,
            limit: args.limit ?? null,
            hitCount: result.matches.length,
            skippedCorrupt: result.skippedCorrupt,
          }, 'memory_searched')
          return { content: JSON.stringify(result) }
        }

        const result = await readMemoryFile({ rootDir: workspaceDir }, { file: args.file })
        return { content: JSON.stringify(result) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn({ err }, 'memory_tool_failed')
        return { content: JSON.stringify({ ok: false, error: message }) }
      }
    },
  }
}

export const memoryTool: Tool<Args> = createMemoryTool()
```

- [ ] **Step 4: Run tool tests and verify they pass**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/memory-store.test.ts src/agent/tools/memory.test.ts src/agent/tools/merged-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit tool migration**

Run:

```bash
git add src/agent/tools/memory.ts src/agent/tools/memory.test.ts src/agent/tools/merged-tools.test.ts
git commit -m "feat: 将 memory 工具迁移到 Markdown 存储"
```

---

### Task 3: Remove Legacy DB Memory Tools

**Files:**
- Delete: `src/agent/tools/remember.ts`
- Delete: `src/agent/tools/recall.ts`
- Delete: `src/agent/tools/remember.test.ts`
- Delete: `src/agent/tools/recall.test.ts`

- [ ] **Step 1: Delete legacy files**

Run:

```bash
rm src/agent/tools/remember.ts src/agent/tools/recall.ts src/agent/tools/remember.test.ts src/agent/tools/recall.test.ts
```

- [ ] **Step 2: Verify no legacy imports remain**

Run:

```bash
rg -n "rememberTool|recallTool|./remember|./recall|memoryEntry" src/agent src/ops docs prompts
```

Expected: no references to `rememberTool`, `recallTool`, `./remember`, or `./recall`. `memoryEntry` may still appear in Prisma schema or old migrations if the schema has not been cleaned yet; do not delete migrations in this task.

- [ ] **Step 3: Run focused memory tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/memory-store.test.ts src/agent/tools/memory.test.ts src/agent/tools/merged-tools.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit cleanup**

Run:

```bash
git add -u src/agent/tools/remember.ts src/agent/tools/recall.ts src/agent/tools/remember.test.ts src/agent/tools/recall.test.ts
git commit -m "refactor: 移除旧 DB 记忆工具"
```

---

### Task 4: Update Runtime Docs and Prompt Guidance

**Files:**
- Modify: `docs/TOOLS.md`
- Modify: `prompts/bot-system.md`
- Modify: `docs/agent-skills/memory_hygiene.md`
- Modify: `src/ops/repo-check.test.ts` if fixture expectations fail

- [ ] **Step 1: Update `docs/TOOLS.md`**

Change the knowledge/history bullet to describe Markdown memory:

```md
- 知识和历史：`memory`（本地 Markdown 长期记忆库，支持 self/person/group/topic）、`skill`、`workspace_bash` 内置的 `help` / `db` / `style` 子命令。
```

Add or update the safety note:

```md
- `memory` 把长期记忆存到 `data/agent-workspace/memory/` 的 Markdown 文件中；这是 bot 生成数据，默认不提交。记忆文件不是 replay 来源，只有 `memory search/read/write` 的有界工具结果能进入 `AgentContext`。
```

- [ ] **Step 2: Update `prompts/bot-system.md`**

Replace the current `memory` progressive-disclosure line with:

```md
- memory: 涉及具体人/群、关系、偏好、旧话题、项目线索、或你自己做过什么时先 action=search 查长期记忆; 需要记下长期有用事实或经验时 action=write, scope 可用 self/person/group/topic; 需要深读某个文件时 action=read.
```

- [ ] **Step 3: Update `docs/agent-skills/memory_hygiene.md`**

Replace the opening and decision bullets with:

```md
`memory` 是长期 Markdown 记忆库，不是聊天摘要，也不是所有消息的备份。它可以记人、群、主题，也可以记 Luna 自己做事形成的经验和线索。

先查:

- 聊到具体人或群，但你不确定以前是否记过偏好、关系、旧话题。
- 对方提到“上次”“之前”“你记得吗”。
- 要对某个人/群做更贴近的回应。
- 接着做一个以前推进过的主题、项目或自审任务。
- 不确定自己之前踩过什么坑、做过什么决定、或形成过什么长期偏好。

再写:

- 对以后仍有用的稳定偏好、事实、关系、禁忌。
- Luna 自己做事时形成的可复用经验、项目线索、设计决定或踩坑记录。
- 用户明确要求你记住。
- 你从多次互动中确认的稳定模式。
```

Keep the existing “不要写” section, and add:

```md
写入时选择合适 scope:

- `self`: 自己做事、偏好、经验、长期线索。
- `person`: 某个 QQ 用户。
- `group`: 某个群。
- `topic`: 一个主题、项目或长期任务。
```

- [ ] **Step 4: Run repo-check**

Run:

```bash
pnpm repo-check
```

Expected: PASS. If local pnpm tries to reinstall dependencies and fails before running repo-check, run the script entrypoint directly:

```bash
node --import tsx scripts/repo-check.ts
```

Expected: prints `repo-check passed`.

- [ ] **Step 5: Run prompt/doc related tests**

Run:

```bash
pnpm exec tsx --test --import tsx src/ops/repo-check.test.ts
```

Expected: PASS. If it fails because fixture strings still expect the old memory wording, update only the expected strings in `src/ops/repo-check.test.ts`.

- [ ] **Step 6: Commit docs**

Run:

```bash
git add docs/TOOLS.md prompts/bot-system.md docs/agent-skills/memory_hygiene.md src/ops/repo-check.test.ts
git commit -m "docs: 更新 Markdown 记忆说明"
```

---

### Task 5: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused memory suite**

Run:

```bash
pnpm exec tsx --test --import tsx src/agent/memory-store.test.ts src/agent/tools/memory.test.ts src/agent/tools/merged-tools.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repo checks**

Run:

```bash
pnpm repo-check
```

Expected: PASS. If pnpm fails before executing the repo script due local dependency approval state, run:

```bash
node --import tsx scripts/repo-check.ts
```

Expected: prints `repo-check passed`.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Run the full test suite if focused tests and typecheck pass**

Run:

```bash
pnpm exec tsx --test --import tsx 'src/**/*.test.ts'
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short --branch
git diff --stat HEAD
git diff --check
```

Expected:

- Branch is ahead by the task commits.
- Only intended memory/store/doc files are changed.
- `git diff --check` prints no whitespace errors.

Do not commit unrelated pre-existing worktree changes.
