import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { recallMemoryEntries, type MemoryEntry, type MemoryScope } from './memory-store.js'

const NOW = new Date('2026-07-13T00:00:00.000Z')

async function withRecallFixture(run: (rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'memory-recall-eval-'))
  try {
    await writeMemoryFile(rootDir, 'people/10001.md', 'person', '王老师', [
      entry('person-coffee', '老王每天早上喜欢自己磨豆制作手冲咖啡。', {
        tier: 'stable',
        aliases: ['老王', '王老师'],
        updatedAt: '2026-07-10T08:00:00.000+08:00',
      }),
      entry('person-tea', '主人有时也会喝清香型绿茶。', { tier: 'recent' }),
      entry('person-disputed', '老王已经不喝咖啡了。', { tier: 'stable', status: 'disputed' }),
      entry('person-superseded', '老王目前住在北京朝阳区。', { tier: 'stable', status: 'superseded' }),
      entry('person-expired', '老王计划七月初去上海出差。', {
        validUntil: '2026-07-01T23:59:59.000+08:00',
      }),
    ])
    await writeMemoryFile(rootDir, 'groups/20002.md', 'group', '咖啡群', [
      entry('group-coffee', '群里经常讨论手冲咖啡和磨豆机。', { tier: 'stable' }),
    ])
    await writeMemoryFile(rootDir, 'topics/coffee.md', 'topic', '手冲器具', [
      entry('topic-coffee', '手冲咖啡需要控制水温和注水节奏。', { tier: 'recent' }),
    ])
    await writeMemoryFile(rootDir, 'self/methods.md', 'self', '排障方法', [
      entry('method-stable', '排障时先看真实代码和运行日志。', { tier: 'stable' }),
      entry('method-recent', '排障时先看真实代码和运行日志。', {
        tier: 'recent',
        updatedAt: '2026-07-12T08:00:00.000+08:00',
      }),
    ])
    await run(rootDir)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

function entry(
  id: string,
  content: string,
  overrides: Partial<MemoryEntry> = {},
): MemoryEntry {
  return {
    id,
    createdAt: '2026-07-01T08:00:00.000+08:00',
    updatedAt: '2026-07-01T08:00:00.000+08:00',
    content,
    sourceMessageIds: [],
    tier: 'recent',
    status: 'active',
    aliases: [],
    supersedes: [],
    ...overrides,
  }
}

async function writeMemoryFile(
  rootDir: string,
  file: string,
  scope: MemoryScope,
  title: string,
  entries: MemoryEntry[],
): Promise<void> {
  const path = join(rootDir, 'memory', file)
  await mkdir(dirname(path), { recursive: true })
  const renderEntry = (item: MemoryEntry) => [
    '<!-- memory-entry',
    `id: ${item.id}`,
    `createdAt: ${item.createdAt}`,
    `updatedAt: ${item.updatedAt}`,
    `tier: ${item.tier}`,
    `status: ${item.status}`,
    `aliases: ${JSON.stringify(item.aliases)}`,
    ...(item.validUntil ? [`validUntil: ${item.validUntil}`] : []),
    `supersedes: ${JSON.stringify(item.supersedes)}`,
    '-->',
    `- ${item.content}`,
    '<!-- /memory-entry -->',
    '',
  ].join('\n')
  const stable = entries.filter((item) => item.tier === 'stable').map(renderEntry).join('')
  const recent = entries.filter((item) => item.tier === 'recent').map(renderEntry).join('')
  await writeFile(path, [
    '---',
    'formatVersion: 1',
    `scope: ${scope}`,
    `title: ${title}`,
    'updatedAt: 2026-07-12T08:00:00.000+08:00',
    'aliases: []',
    '---',
    '',
    '## 稳定记忆',
    '',
    stable.trimEnd(),
    '',
    '## 最近线索',
    '',
    recent.trimEnd(),
    '',
  ].join('\n'), 'utf8')
}

describe('markdown memory lexical recall evaluation', () => {
  test('ranks exact QQ identity and entry aliases above ordinary content matches', async () => {
    await withRecallFixture(async (rootDir) => {
      const byId = await recallMemoryEntries({ rootDir, now: () => NOW }, { query: '10001' })
      assert.equal(byId.matches[0]?.entryId, 'person-coffee')
      assert.equal(byId.matches[0]?.scoreReasons.includes('id_exact'), true)

      const byAlias = await recallMemoryEntries({ rootDir, now: () => NOW }, { query: '老王' })
      assert.equal(byAlias.matches[0]?.entryId, 'person-coffee')
      assert.deepEqual(byAlias.matches[0]?.aliases, ['老王', '王老师'])
      assert.equal(byAlias.matches[0]?.scoreReasons.includes('alias_exact'), true)
    })
  })

  test('handles Chinese phrases, punctuation, and multiple query terms deterministically', async () => {
    await withRecallFixture(async (rootDir) => {
      const phrase = await recallMemoryEntries({ rootDir, now: () => NOW }, {
        query: '手冲、咖啡',
        scope: 'person',
      })
      assert.equal(phrase.matches[0]?.entryId, 'person-coffee')
      assert.equal(phrase.matches[0]?.scoreReasons.includes('content_phrase'), true)

      const multiTerm = await recallMemoryEntries({ rootDir, now: () => NOW }, {
        query: '老王 每天 磨豆',
      })
      assert.equal(multiTerm.matches[0]?.entryId, 'person-coffee')
      assert.equal(multiTerm.matches[0]?.matchedTerms.includes('磨豆'), true)
      assert.equal(multiTerm.matches[0]?.scoreReasons.includes('content_terms'), true)
    })
  })

  test('filters superseded and expired entries while exposing disputed status', async () => {
    await withRecallFixture(async (rootDir) => {
      const superseded = await recallMemoryEntries({ rootDir, now: () => NOW }, { query: '北京朝阳区' })
      assert.deepEqual(superseded.matches, [])

      const expired = await recallMemoryEntries({ rootDir, now: () => NOW }, { query: '上海出差' })
      assert.deepEqual(expired.matches, [])

      const disputed = await recallMemoryEntries({ rootDir, now: () => NOW }, { query: '已经不喝咖啡' })
      assert.equal(disputed.matches[0]?.entryId, 'person-disputed')
      assert.equal(disputed.matches[0]?.status, 'disputed')
      assert.equal(disputed.matches[0]?.validUntil, undefined)
      assert.equal(disputed.matches[0]?.scoreReasons.includes('status_disputed_penalty'), true)
    })
  })

  test('applies scope as a hard filter when identical topics exist across scopes', async () => {
    await withRecallFixture(async (rootDir) => {
      const person = await recallMemoryEntries({ rootDir, now: () => NOW }, {
        query: '手冲咖啡',
        scope: 'person',
      })
      assert.equal(person.matches.length > 0, true)
      assert.equal(person.matches.every((match) => match.scope === 'person'), true)

      const topic = await recallMemoryEntries({ rootDir, now: () => NOW }, {
        query: '手冲咖啡',
        scope: 'topic',
      })
      assert.deepEqual(topic.matches.map((match) => match.entryId), ['topic-coffee'])
    })
  })

  test('uses stable only as a small deterministic bonus and rejects weak matches', async () => {
    await withRecallFixture(async (rootDir) => {
      const methods = await recallMemoryEntries({ rootDir, now: () => NOW }, { query: '真实代码 运行日志' })
      assert.deepEqual(methods.matches.slice(0, 2).map((match) => match.entryId), [
        'method-stable',
        'method-recent',
      ])
      assert.equal(methods.matches[0]!.score > methods.matches[1]!.score, true)

      const weak = await recallMemoryEntries({ rootDir, now: () => NOW }, { query: '火星种土豆' })
      assert.deepEqual(weak.matches, [])
    })
  })
})
