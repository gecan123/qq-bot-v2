import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('notebook tool writes and recalls topic-oriented process notes', async () => {
  const module = await import('./notebook.js').catch(() => null)
  assert.ok(module, 'notebook tool module should exist')
  const rootDir = await mkdtemp(join(tmpdir(), 'notebook-tool-'))
  try {
    const tool = module.createNotebookTool({
      rootDir,
      now: () => new Date('2026-07-13T02:00:00.000Z'),
      id: () => 'note-1',
    })
    const written = JSON.parse(String((await tool.execute({
      action: 'write',
      kind: 'reading',
      topic: '三体',
      content: '读到黑暗森林。',
    }, {} as never)).content))
    assert.equal(written.ok, true)
    assert.equal(written.entry.topic, '三体')

    const searched = JSON.parse(String((await tool.execute({
      action: 'search', query: '黑暗森林', limit: 5,
    }, {} as never)).content))
    assert.equal(searched.entries[0].topic, '三体')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
