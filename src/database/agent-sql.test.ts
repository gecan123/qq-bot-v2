import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { compileNamedSql, validateDbReadSql } from './agent-sql.js'

// validateDbReadSql in MVP-2 only checks: read-only / single-statement / SELECT|WITH /
// no dangerous keywords. It NO LONGER requires :group_id; cross-source SELECTs are legal.
// Whitelist enforcement on params lives in executeDbRead (and the db_read tool).
describe('validateDbReadSql (MVP-2 multi-source)', () => {
  test('allows select with explicit group filter', () => {
    const result = validateDbReadSql('select * from messages where group_id = :group_id')
    assert.equal(result.ok, true)
  })

  test('allows select with private filter (peer_id)', () => {
    const result = validateDbReadSql(
      "select * from messages where scene_kind = 'qq_private' and scene_external_id = :peer_id",
    )
    assert.equal(result.ok, true)
  })

  test('allows cross-source SELECT (no group filter, no peer filter)', () => {
    const result = validateDbReadSql('select count(*) as n from messages')
    assert.equal(result.ok, true)
  })

  test('allows WITH ... SELECT', () => {
    const result = validateDbReadSql('with x as (select 1) select * from x')
    assert.equal(result.ok, true)
  })

  test('rejects non-read-only statements', () => {
    const result = validateDbReadSql('delete from messages where group_id = :group_id')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /only select/i)
  })

  test('rejects multiple statements', () => {
    const result = validateDbReadSql('select * from messages; select 1')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /single statement/i)
  })

  test('rejects dangerous keywords (insert / drop / alter / truncate / etc.)', () => {
    for (const kw of ['insert', 'drop', 'alter', 'truncate', 'grant', 'revoke', 'vacuum', 'merge']) {
      const result = validateDbReadSql(`select 1 ${kw}_dummy`)
      // these are not actually triggering dangerous keyword path because they aren't bare words —
      // but the /\b...\b/ regex catches the keyword surrounded by word boundaries:
      const real = validateDbReadSql(`select * from x where y = ${kw} 1`)
      assert.equal(real.ok, false, `should reject "${kw}" keyword`)
      void result
    }
  })

  test('does not reject SQL just because it lacks :group_id', () => {
    // MVP-1 used to reject "no :group_id" SQLs. MVP-2 allows them: cross-source query is legal.
    const result = validateDbReadSql('select * from messages where sender_id = 100')
    assert.equal(result.ok, true)
  })

  test('does not reject reads from previously-denied tables (DENIED_AGENT_READ_TABLE_RE removed)', () => {
    // reply_audits / proactive_evaluations were dropped from the schema. The denylist regex
    // is removed (D3) — these tables don't exist anymore so the SQL would fail at runtime,
    // but it's no longer a validation error.
    const result = validateDbReadSql('select * from reply_audits')
    assert.equal(result.ok, true)
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

  test('handles :peer_id alongside :group_id (multi-source params)', () => {
    const compiled = compileNamedSql(
      'select 1 where group_id = :group_id or scene_external_id = :peer_id',
      { group_id: 111, peer_id: '10001' },
    )
    assert.match(compiled.text, /\$1/)
    assert.match(compiled.text, /\$2/)
    assert.equal(compiled.values.length, 2)
  })
})
