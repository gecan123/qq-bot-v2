import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { zodToOpenAIStrictToolJsonSchema, zodToToolJsonSchema } from './tool-schema.js'
import { collectStickerTool } from './tools/collect-sticker.js'

test('zodToToolJsonSchema flattens collect_sticker union to Anthropic object schema', () => {
  const json = zodToToolJsonSchema(collectStickerTool.schema)

  assert.equal(json.type, 'object')
  assert.equal('anyOf' in json, false)
  assert.equal('oneOf' in json, false)

  const props = json.properties as Record<string, unknown>
  assert.ok(props.action)
  assert.ok(props.image)
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
