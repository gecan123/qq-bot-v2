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
    const writeResult = await tool.execute({
      action: 'write',
      kind: 'reading',
      topic: '三体',
      content: '读到黑暗森林。',
    }, {} as never)
    const written = JSON.parse(String(writeResult.content))
    assert.equal(written.ok, true)
    assert.equal(written.entry.topic, '三体')
    assert.equal(writeResult.outcome?.progress, true)
    assert.equal(tool.schema.safeParse({
      action: 'write',
      kind: 'project',
      topic: 'OpenAI migration',
      content: 'Translate old notes to Chinese.',
    }).success, false)
    assert.equal(tool.schema.safeParse({
      action: 'write',
      kind: 'project',
      topic: 'OpenAI 迁移',
      content: '把旧记录迁移为中文，保留 API 名称。',
    }).success, true)

    const searched = JSON.parse(String((await tool.execute({
      action: 'search', query: '黑暗森林', limit: 5,
    }, {} as never)).content))
    assert.equal(searched.entries[0].topic, '三体')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
