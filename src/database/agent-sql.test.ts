import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { compileNamedSql, validateDbReadSql } from './agent-sql.js'

describe('validateDbReadSql', () => {
  test('allows select with explicit group scope predicate and :group_id param', () => {
    const result = validateDbReadSql('select * from messages where group_id = :group_id')
    assert.equal(result.ok, true)
  })

  test('allows select with alias group scope predicate', () => {
    const result = validateDbReadSql('select m.message_id from messages m where m.group_id = :group_id')
    assert.equal(result.ok, true)
  })

  test('rejects non-read-only statements', () => {
    const result = validateDbReadSql('delete from messages where group_id = :group_id')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /only select/i)
  })

  test('rejects multiple statements', () => {
    const result = validateDbReadSql('select * from messages where group_id = :group_id; select 1')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /single statement/i)
  })

  test('rejects query without :group_id', () => {
    const result = validateDbReadSql('select * from messages where group_id = 1')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /:group_id/i)
  })

  test('rejects query without explicit group predicate', () => {
    const result = validateDbReadSql('select * from messages where sender_id = :group_id')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /group filter/i)
  })

  test('rejects reply_audits reads even when group-scoped', () => {
    const result = validateDbReadSql('select * from reply_audits where group_id = :group_id')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /reply_audits/i)
  })

  test('rejects proactive_evaluations reads even when group-scoped', () => {
    const result = validateDbReadSql('select * from proactive_evaluations where group_id = :group_id')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /proactive_evaluations/i)
  })
})

describe('compileNamedSql', () => {
  test('compiles named params to positional params in appearance order', () => {
    const compiled = compileNamedSql(
      'select * from messages where group_id = :group_id and sender_id = :sender_id',
      { group_id: 10001, sender_id: 20002 },
    )
    assert.equal(compiled.text, 'select * from messages where group_id = $1 and sender_id = $2')
    assert.deepEqual(compiled.values, [10001, 20002])
  })

  test('throws when required named param is missing', () => {
    assert.throws(
      () =>
        compileNamedSql('select * from messages where group_id = :group_id and sender_id = :sender_id', {
          group_id: 10001,
        }),
      /missing sql param/i,
    )
  })

  test('does not treat postgres cast (::text) as a named parameter', () => {
    const compiled = compileNamedSql(
      'select (:group_id)::text as gid where group_id = :group_id',
      { group_id: 10001 },
    )
    assert.equal(compiled.text, 'select ($1)::text as gid where group_id = $1')
    assert.deepEqual(compiled.values, [10001])
  })
})
