import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import { loadProcessLogSnapshot } from './logs.server.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('process log server reader', () => {
  test('reads only a fixed process file and returns a bounded tail', async () => {
    const root = await createRoot()
    const lines = Array.from({ length: 520 }, (_, index) => `INFO line-${index + 1}`)
    await writeFile(join(root, 'logs', 'processes', 'agent-core.log'), lines.join('\n'), 'utf8')

    const snapshot = await loadProcessLogSnapshot(
      'agent-core',
      new Date('2026-07-26T16:00:00.000Z'),
      root,
    )

    assert.equal(snapshot.entries.length, 500)
    assert.equal(snapshot.entries[0]?.text, 'INFO line-21')
    assert.equal(snapshot.entries.at(-1)?.text, 'INFO line-520')
    assert.equal(snapshot.lineLimitTruncated, true)
    assert.equal(snapshot.sources.find(source => source.id === 'agent-core')?.exists, true)
  })

  test('returns an explicit empty state when a process log does not exist', async () => {
    const root = await createRoot()

    const snapshot = await loadProcessLogSnapshot(
      'browser-controller',
      new Date('2026-07-26T16:00:00.000Z'),
      root,
    )

    assert.deepEqual(snapshot.entries, [])
    assert.match(snapshot.warnings[0] ?? '', /尚未生成/)
  })
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qq-bot-admin-logs-'))
  temporaryRoots.push(root)
  await mkdir(join(root, 'logs', 'processes'), { recursive: true })
  return root
}
