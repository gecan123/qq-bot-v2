import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createSceneAgentContext, type SceneAgentContextStore } from './scene-agent-context-store.js'
import type { AgentContextSnapshot } from './agent-context.js'

function createMemoryStore(): SceneAgentContextStore & { peek(): Map<string, AgentContextSnapshot> } {
  const map = new Map<string, AgentContextSnapshot>()
  return {
    async loadByScene(sceneId) {
      const snap = map.get(sceneId)
      return snap ? { messages: [...snap.messages] } : null
    },
    async saveByScene(sceneId, snapshot) {
      map.set(sceneId, { messages: [...snapshot.messages] })
    },
    peek() {
      return map
    },
  }
}

describe('createSceneAgentContext (Phase B 持久化)', () => {
  test('首次访问无记录时空起步', async () => {
    const store = createMemoryStore()
    const ctx = await createSceneAgentContext({ sceneId: 'qq_group:1', store })
    const snap = await ctx.getSnapshot()
    assert.equal(snap.messages.length, 0)
  })

  test('每次 append 后立即落库,且 byte-equal', async () => {
    const store = createMemoryStore()
    const ctx = await createSceneAgentContext({ sceneId: 'qq_group:1', store })
    await ctx.appendUserMessage({ role: 'user', content: 'hi' })

    const persisted = store.peek().get('qq_group:1')
    assert.ok(persisted)
    assert.deepEqual(persisted.messages, [{ role: 'user', content: 'hi' }])

    await ctx.appendAssistantTurn({ role: 'model', content: 'hello' })
    const persisted2 = store.peek().get('qq_group:1')
    assert.equal(persisted2?.messages.length, 2)
  })

  test('save → load 字节相等(对称性)', async () => {
    const store = createMemoryStore()
    const ctxA = await createSceneAgentContext({ sceneId: 'qq_group:42', store })
    await ctxA.appendUserMessage({ role: 'user', content: '群友A: x' })
    await ctxA.appendToolCalls([{ id: 'c1', name: 'db_read', args: { sql: 'select 1' } }])
    await ctxA.appendToolResults([{ callId: 'c1', name: 'db_read', output: 'ok' }])
    await ctxA.appendAssistantTurn({ role: 'model', content: '查到了' })
    const snapA = await ctxA.getSnapshot()

    // 模拟"重启":新 ctx 用同 store load
    const ctxB = await createSceneAgentContext({ sceneId: 'qq_group:42', store })
    const snapB = await ctxB.getSnapshot()

    assert.equal(JSON.stringify(snapB.messages), JSON.stringify(snapA.messages))
  })

  test('多 scene 互不污染', async () => {
    const store = createMemoryStore()
    const ctxGroup1 = await createSceneAgentContext({ sceneId: 'qq_group:1', store })
    const ctxGroup2 = await createSceneAgentContext({ sceneId: 'qq_group:2', store })

    await ctxGroup1.appendUserMessage({ role: 'user', content: 'in group 1' })
    await ctxGroup2.appendUserMessage({ role: 'user', content: 'in group 2' })

    const snap1 = await ctxGroup1.getSnapshot()
    const snap2 = await ctxGroup2.getSnapshot()
    assert.equal(snap1.messages.length, 1)
    assert.equal(snap2.messages.length, 1)
    assert.equal((snap1.messages[0] as { content: string }).content, 'in group 1')
    assert.equal((snap2.messages[0] as { content: string }).content, 'in group 2')
  })

  test('replaceMessages 后落库内容也被替换', async () => {
    const store = createMemoryStore()
    const ctx = await createSceneAgentContext({ sceneId: 'qq_group:1', store })
    await ctx.appendUserMessage({ role: 'user', content: '老1' })
    await ctx.appendUserMessage({ role: 'user', content: '老2' })
    await ctx.replaceMessages([{ role: 'user', content: '[历史摘要]\n老1+老2 已压缩' }])

    const persisted = store.peek().get('qq_group:1')
    assert.equal(persisted?.messages.length, 1)
    assert.match((persisted?.messages[0] as { content: string }).content, /历史摘要/)
  })
})
