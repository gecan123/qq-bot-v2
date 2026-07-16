import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { zodToOpenAIStrictToolJsonSchema, zodToToolJsonSchema } from './tool-schema.js'
import { createInMemoryTaskRegistry } from './background-task-registry.js'
import { collectStickerTool } from './tools/collect-sticker.js'
import { createGenerateImageTool } from './tools/generate-image.js'
import { notebookTool } from './tools/notebook.js'
import { memoryTool } from './tools/memory.js'
import { pauseTool } from './tools/pause.js'
import { createScheduleTool } from './tools/schedule.js'
import { createSendMessageTool } from './tools/send-message.js'
import type { ScheduleRuntime } from './schedule-runtime.js'
import type { QqConversationController } from './tools/qq-conversation.js'

const conversationStub: QqConversationController = {
  getCurrent: () => null,
  async resolveCurrent() { return { ok: false, code: 'CHAT_CONTEXT_UNAVAILABLE' } },
  async open(target) { return { ok: true, current: target } },
  close() {},
  async list() { return [] },
}

test('zodToToolJsonSchema flattens collect_sticker union to Anthropic object schema', () => {
  const json = zodToToolJsonSchema(collectStickerTool.schema)

  assert.equal(json.type, 'object')
  assert.equal('anyOf' in json, false)
  assert.equal('oneOf' in json, false)

  const props = json.properties as Record<string, unknown>
  assert.ok(props.action)
  assert.ok(props.image)

  const action = props.action as Record<string, unknown>
  assert.match(String(action.description), /action=collect 时必须提供 image, name, tags/)
  assert.match(String(action.description), /action=search 时必须提供 query/)

  const image = props.image as Record<string, unknown>
  assert.match(String(image.description), /action=collect 时必填/)
})

test('zodToToolJsonSchema preserves conditional requirements for every notebook action', () => {
  const json = zodToToolJsonSchema(notebookTool.schema)

  assert.deepEqual(json.required, ['action'])
  const props = json.properties as Record<string, Record<string, unknown>>
  assert.match(String(props.action.description), /action=write 时必须提供 kind, topic, content/)
  assert.match(String(props.action.description), /action=search 时必须提供 query/)
  assert.match(String(props.action.description), /action=update 时必须提供 id, expectedRevision, content/)
  assert.match(String(props.action.description), /action=compact 时必须提供 ids, expectedRevision, content/)
  assert.match(String(props.kind.description), /action=write 时必填/)
  assert.match(String(props.topic.description), /action=write 时必填/)
  assert.match(String(props.expectedRevision.description), /action=update 或 action=delete 或 action=compact 时必填/)
})

test('tool schemas disclose custom validation constraints that JSON Schema cannot encode', () => {
  const generateImage = createGenerateImageTool({ taskRegistry: createInMemoryTaskRegistry() })
  const imageJson = zodToToolJsonSchema(generateImage.schema)
  const imageProps = imageJson.properties as Record<string, Record<string, unknown>>
  assert.match(String(imageProps.image.description), /与 images 二选一, 不能同时提供/)
  assert.match(String(imageProps.images.description), /与 image 二选一, 不能同时提供/)

  const memoryJson = zodToToolJsonSchema(memoryTool.schema)
  const memoryProps = memoryJson.properties as Record<string, Record<string, unknown>>
  assert.match(String(memoryProps.file.description), /memory 内的 \.md 相对路径/)
  assert.match(String(memoryProps.file.description), /不允许绝对路径、反斜杠或 \.\./)
  assert.match(String(memoryProps.replacementEntryId.description), /action=supersede_entry 时必填/)
  assert.equal('trust' in memoryProps, false)
})

test('send_message exposes music as one provider-compatible object schema', () => {
  const sendMessage = createSendMessageTool({
    sender: { async sendSegments() { return { success: true, attempts: 1 } } },
    targetPolicy: { async authorize() { return { allowed: true } } },
    conversations: conversationStub,
  })
  const json = zodToToolJsonSchema(sendMessage.schema)
  const props = json.properties as Record<string, Record<string, unknown>>
  assert.equal('target' in props, false)
  assert.equal('mode' in props, false)
  assert.equal('replyToMessageId' in props, false)
  assert.ok(props.message)
  assert.equal(props.reply_to.type, 'integer')
  assert.equal(props.mention_user_id.type, 'integer')
  const musicVariants = props.music.anyOf as Array<Record<string, unknown>>
  const music = musicVariants.find((variant) => variant.type === 'object')

  assert.ok(music)
  assert.equal('anyOf' in music, false)
  assert.equal('oneOf' in music, false)
  const musicProps = music.properties as Record<string, Record<string, unknown>>
  assert.match(String(musicProps.id.description), /非 custom 时必填/)
  assert.match(String(musicProps.url.description), /platform=custom 时必填/)
})

test('zodToOpenAIStrictToolJsonSchema makes optional object fields required and nullable', () => {
  const schema = z.object({
    target: z.union([
      z.object({
        type: z.literal('group'),
        groupId: z.number().int(),
        mentionUserId: z.number().int().optional(),
      }),
      z.object({
        type: z.literal('private'),
        userId: z.number().int(),
      }),
    ]),
    text: z.string().optional(),
  })

  const json = zodToOpenAIStrictToolJsonSchema(schema)
  assert.deepEqual(json.required, ['target', 'text'])

  const props = json.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(props.text, {
    anyOf: [{ type: 'string' }, { type: 'null' }],
  })

  const target = props.target
  const variants = target.anyOf as Array<Record<string, unknown>>
  const group = variants[0]!
  assert.deepEqual(group.required, ['type', 'groupId', 'mentionUserId'])
  const groupProps = group.properties as Record<string, unknown>
  assert.deepEqual(groupProps.mentionUserId, {
    anyOf: [
      {
        type: 'integer',
        minimum: -9007199254740991,
        maximum: 9007199254740991,
      },
      { type: 'null' },
    ],
  })
})

test('zodToOpenAIStrictToolJsonSchema keeps pause schema strict and rest-only', () => {
  const json = zodToOpenAIStrictToolJsonSchema(pauseTool.schema)

  assert.equal(json.type, 'object')
  assert.equal('oneOf' in json, false)
  assert.equal('anyOf' in json, false)
  assert.deepEqual(json.required, ['action', 'durationSeconds', 'reason', 'intention'])

  const props = json.properties as Record<string, Record<string, unknown>>
  assert.equal(props.action.const, 'rest')
  assert.equal(props.intention.type, 'object')
  assert.deepEqual(props.intention.required, ['primaryDirection', 'alternativeDirection'])
  const intentionProps = props.intention.properties as Record<string, Record<string, unknown>>
  assert.equal(intentionProps.primaryDirection.type, 'string')
  assert.equal(intentionProps.alternativeDirection.type, 'string')
  assert.equal('waitingDirection' in intentionProps, false)
  assert.deepEqual(props.durationSeconds, {
    default: 60,
    description: '自己安排的短休息秒数, 默认 60, 范围 30..600.',
    type: 'integer',
    minimum: 30,
    maximum: 600,
  })
  assert.equal('confirmed' in props, false)
})

test('zodToOpenAIStrictToolJsonSchema removes unsupported string formats', () => {
  const schema = z.object({
    url: z.string().url().optional(),
  })

  const json = zodToOpenAIStrictToolJsonSchema(schema)
  const props = json.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(props.url.anyOf, [
    { type: 'string' },
    { type: 'null' },
  ])
})

test('schedule schema converts for both providers with actions and both at variants', () => {
  const runtime: ScheduleRuntime = {
    async start() {},
    async create() { throw new Error('not used') },
    async list() { return [] },
    async cancel(id) { return { status: 'already_absent', id } },
    async stop() {},
  }
  const schema = createScheduleTool(runtime).schema

  for (const json of [
    zodToToolJsonSchema(schema),
    zodToOpenAIStrictToolJsonSchema(schema),
  ]) {
    assert.equal(json.type, 'object')
    const props = json.properties as Record<string, Record<string, unknown>>
    assert.deepEqual(props.action.enum, ['create', 'list', 'cancel'])
    const serializedSchedule = JSON.stringify(props.schedule)
    assert.match(serializedSchedule, /\"at\"/)
    assert.match(serializedSchedule, /afterSeconds/)
    assert.equal(serializedSchedule.match(/\"const\":\"at\"/g)?.length, 2)
  }
})
