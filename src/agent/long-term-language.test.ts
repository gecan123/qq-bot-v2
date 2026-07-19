import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasChineseNarrative } from './long-term-language.js'

test('accepts Chinese narration with preserved technical identifiers', () => {
  assert.equal(hasChineseNarrative('使用 TypeScript、OpenAI API 和 `pnpm typecheck` 验证这次迁移。'), true)
  assert.equal(hasChineseNarrative('先说明用途。\n```ts\nconst message = "English code is preserved"\n```'), true)
})

test('rejects English prose that only happens to contain Chinese names', () => {
  assert.equal(hasChineseNarrative(
    'Early-morning 大漩涡群 still buzzing past 5:30am with the same handful of faces drifting through.',
  ), false)
  assert.equal(hasChineseNarrative('Keep API names and paths unchanged while translating the explanation.'), false)
})
