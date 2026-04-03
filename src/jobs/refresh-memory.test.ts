import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { prisma } from '../database/client.js'
import { config } from '../config/index.js'
import { setLlmProvider } from '../llm/provider.js'
import { refreshGroup } from './refresh-memory.js'

const originalMessageFindMany = prisma.message.findMany
const originalGroupMemoryFindUnique = prisma.groupMemory.findUnique
const originalGroupMemoryUpsert = prisma.groupMemory.upsert
const originalGroupMemoryCursorFindUnique = prisma.groupMemoryCursor.findUnique
const originalGroupMemoryCursorUpsert = prisma.groupMemoryCursor.upsert
const originalUserMemoryFindUnique = prisma.userMemory.findUnique
const originalUserMemoryUpsert = prisma.userMemory.upsert
const originalMemoryJobSkipThreshold = config.memoryJobSkipThreshold

afterEach(() => {
  prisma.message.findMany = originalMessageFindMany
  prisma.groupMemory.findUnique = originalGroupMemoryFindUnique
  prisma.groupMemory.upsert = originalGroupMemoryUpsert
  prisma.groupMemoryCursor.findUnique = originalGroupMemoryCursorFindUnique
  prisma.groupMemoryCursor.upsert = originalGroupMemoryCursorUpsert
  prisma.userMemory.findUnique = originalUserMemoryFindUnique
  prisma.userMemory.upsert = originalUserMemoryUpsert
  ;(config as { memoryJobSkipThreshold: number }).memoryJobSkipThreshold = originalMemoryJobSkipThreshold
  setLlmProvider(undefined as never)
})

describe('refreshGroup', () => {
  test('uses structured memory methods and stores stringified json payloads', async () => {
    ;(config as { memoryJobSkipThreshold: number }).memoryJobSkipThreshold = 1

    const groupUpserts: any[] = []
    const userUpserts: any[] = []
    let groupPrompt = ''
    let userPrompt = ''

    prisma.message.findMany = (async () => [
      {
        id: 1,
        groupId: 123n,
        groupName: '测试群',
        mediaReferenceIds: [],
        messageId: 1001n,
        senderId: 456n,
        senderNickname: '小林',
        senderGroupNickname: '小林同学',
        content: [{ type: 'text', content: '周六去吃火锅吗' }],
        rawContent: null,
        rawMessage: null,
        searchText: '',
        resolvedText: null,
        sentAt: new Date('2026-04-03T10:00:00+08:00'),
        createdAt: new Date('2026-04-03T10:00:00+08:00'),
      },
      {
        id: 2,
        groupId: 123n,
        groupName: '测试群',
        mediaReferenceIds: [],
        messageId: 1002n,
        senderId: 456n,
        senderNickname: '小林',
        senderGroupNickname: '小林同学',
        content: [{ type: 'text', content: '我可以负责订位' }],
        rawContent: null,
        rawMessage: null,
        searchText: '',
        resolvedText: null,
        sentAt: new Date('2026-04-03T10:05:00+08:00'),
        createdAt: new Date('2026-04-03T10:05:00+08:00'),
      },
    ]) as never

    prisma.groupMemory.findUnique = (async () => null) as never
    prisma.groupMemory.upsert = (async (args: any) => {
      groupUpserts.push(args)
      return {} as never
    }) as never
    prisma.groupMemoryCursor.findUnique = (async () => null) as never
    prisma.groupMemoryCursor.upsert = (async () => ({} as never)) as never
    prisma.userMemory.findUnique = (async () => null) as never
    prisma.userMemory.upsert = (async (args: any) => {
      userUpserts.push(args)
      return {} as never
    }) as never

    const structuredGroupSummary = {
      summary: '这个群最近在组织周末聚餐，交流直接，执行推进很快。',
      topics: ['周末聚餐', '火锅', '订位安排'],
      activePatterns: ['上午有人发起安排，几分钟内就有人接单推进'],
      styleTags: ['务实', '节奏快'],
    }
    const structuredUserProfile = {
      profile: '说话直接，偏执行型，常主动接具体安排。',
      traits: ['直接', '主动'],
      interests: ['聚餐', '线下活动'],
      speakingStyle: ['短句确认', '偏行动导向'],
      examples: ['周六去吃火锅吗', '我可以负责订位'],
    }

    setLlmProvider({
      describeImage: async () => '',
      generateGroupMemorySummary: async (_systemInstruction, prompt) => {
        groupPrompt = prompt
        return structuredGroupSummary
      },
      generateUserMemoryProfile: async (_systemInstruction, prompt) => {
        userPrompt = prompt
        return structuredUserProfile
      },
    })

    await refreshGroup(123)

    assert.match(groupPrompt, /周六去吃火锅吗/)
    assert.match(userPrompt, /我可以负责订位/)
    assert.equal(groupUpserts.length, 1)
    assert.equal(groupUpserts[0].create.summary, JSON.stringify(structuredGroupSummary))
    assert.equal(userUpserts.length, 1)
    assert.equal(userUpserts[0].create.profile, JSON.stringify(structuredUserProfile))
    assert.deepEqual(userUpserts[0].create.examples, structuredUserProfile.examples)
  })
})
