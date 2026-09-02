import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('notebook tool checkpoints and recalls one current topic state', async () => {
  const module = await import('./notebook.js').catch(() => null)
  assert.ok(module, 'notebook tool module should exist')
  const rootDir = await mkdtemp(join(tmpdir(), 'notebook-tool-'))
  try {
    const tool = module.createNotebookTool({
      rootDir,
      now: () => new Date('2026-07-13T02:00:00.000Z'),
      id: () => 'note-1',
    })
    const checkpointResult = await tool.execute({
      action: 'checkpoint',
      kind: 'reading',
      topic: '三体',
      content: '读到黑暗森林。',
    }, {} as never)
    const checkpointed = JSON.parse(String(checkpointResult.content))
    assert.equal(checkpointed.ok, true)
    assert.equal(checkpointed.topic, '三体')
    assert.equal(checkpointed.created, true)
    assert.equal(checkpointResult.outcome?.progress, false)
    const unchangedResult = await tool.execute({
      action: 'checkpoint',
      kind: 'reading',
      topic: '三体',
      content: '读到黑暗森林。',
    }, {} as never)
    assert.equal(JSON.parse(String(unchangedResult.content)).changed, false)
    assert.equal(unchangedResult.outcome?.code, 'unchanged')
    assert.equal(tool.schema.safeParse({
      action: 'checkpoint',
      kind: 'project',
      topic: 'OpenAI migration',
      content: 'Translate old notes to Chinese.',
    }).success, false)
    assert.equal(tool.schema.safeParse({
      action: 'checkpoint',
      kind: 'project',
      topic: 'OpenAI 迁移',
      content: '把旧记录迁移为中文，保留 API 名称。',
    }).success, true)
    assert.equal(tool.schema.safeParse({
      action: 'write',
      kind: 'project',
      topic: 'OpenAI 迁移',
      content: '追加旧式日志。',
    }).success, false)

    const searched = JSON.parse(String((await tool.execute({
      action: 'search', query: '黑暗森林', limit: 5,
    }, {} as never)).content))
    assert.equal(searched.entries[0].topic, '三体')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('notebook tool parks after the general topic limit is reached', async () => {
  const module = await import('./notebook.js')
  const rootDir = await mkdtemp(join(tmpdir(), 'notebook-tool-limit-'))
  try {
    let id = 0
    const tool = module.createNotebookTool({
      rootDir,
      now: () => new Date('2026-09-01T02:00:00.000Z'),
      id: () => `note-${++id}`,
    })
    for (const topic of ['停止', '最终停止', '真正的停止', '最终状态', '最终承认']) {
      await tool.execute({ action: 'checkpoint', kind: 'general', topic, content: `${topic}的当前状态。` }, {} as never)
    }
    const result = await tool.execute({
      action: 'checkpoint', kind: 'general', topic: '最终决定', content: '再次创建近义主题。',
    }, {} as never)

    assert.equal(JSON.parse(String(result.content)).code, 'topic_limit_reached')
    assert.deepEqual(result.outcome, {
      ok: false,
      code: 'topic_limit_reached',
      error: JSON.parse(String(result.content)).error,
      progress: false,
      continuation: 'wait_attention',
    })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
