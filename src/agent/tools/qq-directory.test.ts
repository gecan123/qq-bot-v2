import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { zodToToolJsonSchema } from '../tool-schema.js'
import { createQqDirectoryTool } from './qq-directory.js'

const friends = [
  { userId: 10001, nickname: 'Alice', remark: '项目搭档' },
  { userId: 10002, nickname: '小明', remark: '' },
  { userId: 10003, nickname: 'Bob', remark: null },
]

const groups = [
  { groupId: 20001, groupName: '配置群', groupRemark: '工作', memberCount: 12, maxMemberCount: 200 },
  { groupId: 20002, groupName: '未配置群', memberCount: 30, maxMemberCount: 500 },
]

function createTool() {
  return createQqDirectoryTool({
    groupIds: [20001, 29999],
    async loadFriends() { return friends },
    async loadGroups() { return groups },
  })
}

describe('qq_directory tool', () => {
  test('lists every current friend with bounded pagination', async () => {
    const result = await createTool().execute({
      action: 'list_friends',
      offset: 1,
      limit: 1,
    }, undefined as never)
    const payload = JSON.parse(result.content as string) as {
      total: number
      hasMore: boolean
      nextOffset: number | null
      items: Array<{ userId: number; displayName: string; remark: string | null }>
    }

    assert.equal(payload.total, 3)
    assert.equal(payload.hasMore, true)
    assert.equal(payload.nextOffset, 2)
    assert.deepEqual(payload.items, [{
      userId: 10002,
      nickname: '小明',
      remark: null,
      displayName: '小明',
    }])
  })

  test('searches current friends by QQ number, nickname, or remark', async () => {
    for (const query of ['10001', 'alice', '项目']) {
      const result = await createTool().execute({ action: 'search_friends', query }, undefined as never)
      const payload = JSON.parse(result.content as string) as { items: Array<{ userId: number }> }
      assert.deepEqual(payload.items.map((item) => item.userId), [10001])
    }
  })

  test('lists only configured groups that the account has actually joined', async () => {
    const result = await createTool().execute({ action: 'list_groups' }, undefined as never)
    const payload = JSON.parse(result.content as string) as {
      total: number
      items: Array<Record<string, unknown>>
    }

    assert.equal(payload.total, 1)
    assert.deepEqual(payload.items, [{
      groupId: 20001,
      groupName: '配置群',
      groupRemark: '工作',
      memberCount: 12,
      maxMemberCount: 200,
    }])
  })

  test('returns a structured error when NapCat directory loading fails', async () => {
    const tool = createQqDirectoryTool({
      groupIds: [],
      async loadFriends() { throw new Error('socket closed') },
      async loadGroups() { return [] },
    })
    const result = await tool.execute({ action: 'list_friends' }, undefined as never)
    const payload = JSON.parse(result.content as string) as { ok: boolean; error: string }

    assert.equal(payload.ok, false)
    assert.match(payload.error, /socket closed/)
  })

  test('publishes one provider-compatible object schema with conditional guidance', () => {
    const json = zodToToolJsonSchema(createTool().schema)
    const props = json.properties as Record<string, Record<string, unknown>>

    assert.equal(json.type, 'object')
    assert.equal('oneOf' in json, false)
    assert.equal('anyOf' in json, false)
    assert.match(String(props.action.description), /search_friends.*query/)
    assert.match(String(props.query.description), /search_friends 时必填/)
    assert.equal(props.limit.maximum, 50)
  })
})
