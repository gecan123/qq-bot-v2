import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { loadGroupCustomizations } from './group-prompts.js'

let tmpDir: string

function fixture(name: string, content: string): string {
  const p = path.join(tmpDir, name)
  writeFileSync(p, content, 'utf-8')
  return p
}

describe('loadGroupCustomizations', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'group-prompts-test-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('合法 yaml (1 群) 解析正确, snake_case → camelCase', () => {
    const p = fixture(
      'g.yaml',
      [
        'groups:',
        '  - id: 111',
        '    frequency_hint: chatty',
        '    body: |',
        '      喜欢聊吃。',
      ].join('\n'),
    )
    const result = loadGroupCustomizations(p)
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 111)
    assert.equal(result[0].frequencyHint, 'chatty')
    assert.match(result[0].body, /喜欢聊吃/)
  })

  test('groups: [] 显式空数组 → 返回空', () => {
    const p = fixture('g.yaml', 'groups: []\n')
    const result = loadGroupCustomizations(p)
    assert.deepEqual(result, [])
  })

  test('完全空文件 → 返回空 (zod default 接住)', () => {
    const p = fixture('g.yaml', '')
    const result = loadGroupCustomizations(p)
    assert.deepEqual(result, [])
  })

  test('文件没有顶层 groups 字段 → 返回空', () => {
    const p = fixture('g.yaml', 'something_else: 42\n')
    const result = loadGroupCustomizations(p)
    assert.deepEqual(result, [])
  })

  test('frequency_hint 非枚举值 → throw', () => {
    const p = fixture(
      'g.yaml',
      [
        'groups:',
        '  - id: 111',
        '    frequency_hint: silent',
        '    body: ""',
      ].join('\n'),
    )
    assert.throws(() => loadGroupCustomizations(p))
  })

  test('id 非整数 → throw', () => {
    const p = fixture(
      'g.yaml',
      [
        'groups:',
        '  - id: "abc"',
        '    frequency_hint: normal',
        '    body: ""',
      ].join('\n'),
    )
    assert.throws(() => loadGroupCustomizations(p))
  })

  test('缺 body 字段 → throw (强制 string, 空值需显式空串)', () => {
    const p = fixture(
      'g.yaml',
      [
        'groups:',
        '  - id: 111',
        '    frequency_hint: normal',
      ].join('\n'),
    )
    assert.throws(() => loadGroupCustomizations(p))
  })

  test('文件不存在 → throw (fs error 透传)', () => {
    const missing = path.join(tmpDir, 'does-not-exist.yaml')
    assert.throws(() => loadGroupCustomizations(missing))
  })

  test('多个群顺序保留 (输出顺序 = 文件顺序)', () => {
    const p = fixture(
      'g.yaml',
      [
        'groups:',
        '  - id: 222',
        '    frequency_hint: quiet',
        '    body: ""',
        '  - id: 111',
        '    frequency_hint: chatty',
        '    body: ""',
      ].join('\n'),
    )
    const result = loadGroupCustomizations(p)
    assert.deepEqual(
      result.map((g) => g.id),
      [222, 111],
    )
  })

  test('body 空字符串合法', () => {
    const p = fixture(
      'g.yaml',
      [
        'groups:',
        '  - id: 111',
        '    frequency_hint: normal',
        '    body: ""',
      ].join('\n'),
    )
    const result = loadGroupCustomizations(p)
    assert.equal(result.length, 1)
    assert.equal(result[0].body, '')
  })
})
