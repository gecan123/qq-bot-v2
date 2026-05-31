import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createInMemoryTaskRegistry } from '../background-task-registry.js'
import { buildBotTools } from './index.js'
import { styleGuideTool } from './style-guide.js'
import type { MessageSender } from '../../messaging/message-sender.js'

const mockSender: MessageSender = {
  async replyToMessage() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
  async sendPrivateMessage() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
  async sendGroupMessage() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
  async sendSegments() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
}

describe('style_guide tool', () => {
  test('默认只返回风格索引, 不把具体风格全部塞给模型', async () => {
    assert.equal(styleGuideTool.name, 'style_guide')
    assert.match(styleGuideTool.description, /按需/)

    const result = await styleGuideTool.execute({}, undefined as never)
    assert.equal(typeof result.content, 'string')
    assert.ok(Buffer.byteLength(result.content as string, 'utf8') <= 1_200)
    assert.match(result.content as string, /按需风格指南/)
    assert.match(result.content as string, /base/)
    assert.match(result.content as string, /anti_patterns/)
    assert.match(result.content as string, /special_cases/)
    assert.equal((result.content as string).includes('反例对照'), false)
  })

  test('按 section 返回具体风格文件', async () => {
    const result = await styleGuideTool.execute({ section: 'anti_patterns' }, undefined as never)

    assert.equal(typeof result.content, 'string')
    assert.match(result.content as string, /反例对照/)
    assert.match(result.content as string, /点评员腔/)
    assert.equal((result.content as string).includes('特殊场景'), false)
  })

  test('注册在 bot 工具集中, 让 system prompt 的按需入口可调用', () => {
    const tools = buildBotTools({
      sender: mockSender,
      groupAmbientSendIds: new Set(),
      taskRegistry: createInMemoryTaskRegistry(),
      groupIds: [],
      metadata: { groupNames: new Map() },
      groupCustomizations: [],
    })

    assert.ok(tools.some((tool) => tool.name === 'style_guide'))
  })
})
