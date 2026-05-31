import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseAgentDbQueryInput } from './agent-db-query-cli.js'

describe('parseAgentDbQueryInput', () => {
  test('parses JSON input with sql and params', () => {
    assert.deepEqual(
      parseAgentDbQueryInput('{"sql":"select * from messages where group_id=:group_id","params":{"group_id":111}}'),
      {
        sql: 'select * from messages where group_id=:group_id',
        params: { group_id: 111 },
      },
    )
  })

  test('treats plain text input as sql', () => {
    assert.deepEqual(parseAgentDbQueryInput('select count(*) from messages'), {
      sql: 'select count(*) from messages',
      params: undefined,
    })
  })

  test('rejects JSON without sql string', () => {
    assert.throws(() => parseAgentDbQueryInput('{"params":{}}'), /sql/)
  })
})
