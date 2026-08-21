import assert from 'node:assert/strict'
import { test } from 'node:test'
import { persistFeishuIncomingMessage } from './feishu-ingress.js'

test('Feishu ingress persists normalized text, reply/thread, mentions and media in one message fact', async () => {
  const facts: unknown[] = []
  const mediaInputs: unknown[] = []
  const downloads: unknown[] = []
  const result = await persistFeishuIncomingMessage({
    accountId: 'cli_1',
    eventId: 'evt_1',
    message: {
      messageId: 'om_1', chatId: 'oc_1', chatType: 'group', senderId: 'ou_1',
      senderName: 'Alice', content: 'hello', rawContentType: 'post',
      resources: [{ type: 'image', fileKey: 'img_1', fileName: 'a.png' }],
      mentions: [{ key: '@_user_1', openId: 'ou_2', name: 'Bob' }],
      mentionAll: false, mentionedBot: true, rootId: 'om_root', threadId: 'omt_1',
      replyToMessageId: 'om_parent', createTime: 1_700_000_000_000,
    },
  }, {
    async downloadResource(messageId, fileKey, type) {
      downloads.push({ messageId, fileKey, type })
      return Buffer.from('png')
    },
    async createMedia(input) { mediaInputs.push(input); return 7 },
    async appendFact(input) {
      facts.push(input)
      return { rowId: 9, createdAt: new Date(0), sentAt: new Date(0) }
    },
  })

  assert.equal(result.rowId, 9)
  assert.deepEqual(downloads, [{ messageId: 'om_1', fileKey: 'img_1', type: 'image' }])
  assert.equal(mediaInputs.length, 1)
  assert.deepEqual((facts[0] as { mediaReferenceIds: string[] }).mediaReferenceIds, ['7'])
  assert.deepEqual((facts[0] as { conversation: unknown }).conversation, {
    platform: 'feishu', accountId: 'cli_1', kind: 'group', externalId: 'oc_1',
  })
  assert.equal((facts[0] as { replyToExternalId: string }).replyToExternalId, 'om_parent')
  assert.equal((facts[0] as { rootExternalId: string }).rootExternalId, 'om_root')
  assert.equal((facts[0] as { threadExternalId: string }).threadExternalId, 'omt_1')
  assert.deepEqual((facts[0] as { content: unknown }).content, [
    { type: 'reply', messageId: 'om_parent' },
    { type: 'text', content: 'hello' },
    { type: 'at', targetId: 'ou_2', targetName: 'Bob' },
    { type: 'image', referenceId: '7', fileName: 'a.png', fileSize: '3' },
  ])
})

test('Feishu ingress keeps the message fact when one media download fails', async () => {
  const facts: unknown[] = []
  await persistFeishuIncomingMessage({
    accountId: 'cli_1', eventId: 'evt_failed_media',
    message: {
      messageId: 'om_failed', chatId: 'oc_1', chatType: 'group', senderId: 'ou_1',
      content: '正文', rawContentType: 'file',
      resources: [{ type: 'file', fileKey: 'file_1', fileName: 'notes.pdf' }],
      mentions: [], mentionAll: false, mentionedBot: false, createTime: 1,
    },
  }, {
    async downloadResource() { throw new Error('permission denied') },
    async appendFact(input) {
      facts.push(input)
      return { rowId: 11, createdAt: new Date(0), sentAt: new Date(0) }
    },
  })
  assert.equal(facts.length, 1)
  assert.match(JSON.stringify((facts[0] as { content: unknown }).content), /下载失败/)
})

test('Feishu ingress keeps an explicit placeholder instead of storing media above 20MB', async () => {
  const facts: unknown[] = []
  await persistFeishuIncomingMessage({
    accountId: 'cli_1', eventId: 'evt_big',
    message: {
      messageId: 'om_big', chatId: 'oc_1', chatType: 'p2p', senderId: 'ou_1',
      content: '', rawContentType: 'file',
      resources: [{ type: 'file', fileKey: 'file_1', fileName: 'huge.zip' }],
      mentions: [], mentionAll: false, mentionedBot: false, createTime: 1,
    },
  }, {
    async downloadResource() { return Buffer.alloc(20 * 1024 * 1024 + 1) },
    async createMedia() { assert.fail('oversized media must not be stored') },
    async appendFact(input) {
      facts.push(input)
      return { rowId: 10, createdAt: new Date(0), sentAt: new Date(0) }
    },
  })
  assert.deepEqual((facts[0] as { mediaReferenceIds: string[] }).mediaReferenceIds, [])
  assert.match(JSON.stringify((facts[0] as { content: unknown }).content), /超过 20MB/)
})

test('Feishu stickers download as images and enter the description queue once', async () => {
  const downloadTypes: string[] = []
  const described: number[] = []
  await persistFeishuIncomingMessage({
    accountId: 'cli_1', eventId: 'evt_sticker',
    message: {
      messageId: 'om_sticker', chatId: 'oc_1', chatType: 'group', senderId: 'ou_1',
      content: '', rawContentType: 'sticker',
      resources: [{ type: 'sticker', fileKey: 'sticker_1' }],
      mentions: [], mentionAll: false, mentionedBot: false, createTime: 1,
    },
  }, {
    async downloadResource(_messageId, _fileKey, type) {
      downloadTypes.push(type)
      return Buffer.from('sticker')
    },
    async createMedia() { return 17 },
    describeMedia(mediaId) { described.push(mediaId) },
    async appendFact() { return { rowId: 12, createdAt: new Date(0), sentAt: new Date(0) } },
  })

  assert.deepEqual(downloadTypes, ['image'])
  assert.deepEqual(described, [17])
})
