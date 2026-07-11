import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { zodToOpenAIStrictToolJsonSchema, zodToToolJsonSchema } from './tool-schema.js'
import { createInMemoryTaskRegistry } from './background-task-registry.js'
import { collectStickerTool } from './tools/collect-sticker.js'
import { createGenerateImageTool } from './tools/generate-image.js'
import { journalTool } from './tools/journal.js'
import { memoryTool } from './tools/memory.js'
import { pauseTool } from './tools/pause.js'

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

test('zodToToolJsonSchema preserves conditional requirements for every journal action', () => {
  const json = zodToToolJsonSchema(journalTool.schema)

  assert.deepEqual(json.required, ['action'])
  const props = json.properties as Record<string, Record<string, unknown>>
  assert.match(String(props.action.description), /action=write 时必须提供 kind, content/)
  assert.match(String(props.action.description), /action=search 时必须提供 query/)
  assert.match(String(props.action.description), /action=update 时必须提供 id, expectedRevision, content/)
  assert.match(String(props.action.description), /action=compact 时必须提供 ids, expectedRevision, content/)
  assert.match(String(props.kind.description), /action=write 时必填/)
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
  assert.deepEqual(json.required, ['action', 'durationSeconds', 'intention'])

  const props = json.properties as Record<string, Record<string, unknown>>
  assert.equal(props.action.const, 'rest')
  assert.deepEqual(props.intention, {
    description: '休息前列 4 到 8 个具体可执行的候选方向; 至少两个能立即用现有工具开始, 等待外部消息最多一个. 醒来后先尝试一个, 不要写“继续看”之类占位句.',
    type: 'string',
    minLength: 1,
    maxLength: 600,
  })
  assert.deepEqual(props.durationSeconds, {
    default: 60,
    description: '自己安排的休息秒数, 默认 60, 通常 30..120, 范围 30..1800.',
    type: 'integer',
    minimum: 30,
    maximum: 1800,
  })
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
