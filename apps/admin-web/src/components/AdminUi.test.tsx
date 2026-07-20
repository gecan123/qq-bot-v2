import assert from 'node:assert/strict'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, test } from 'vitest'
import { JsonBlock } from './AdminUi.js'

afterEach(cleanup)

describe('JsonBlock', () => {
  test('pretty prints objects and JSON strings with two-space indentation', () => {
    const { rerender } = render(<JsonBlock value={{ ok: true, nested: { count: 2 } }} />)
    assert.equal(screen.getByText(/"nested"/).textContent, '{\n  "ok": true,\n  "nested": {\n    "count": 2\n  }\n}')

    rerender(<JsonBlock value={'{"items":[1,2]}'} variant="preview" />)
    assert.equal(screen.getByText(/"items"/).textContent, '{\n  "items": [\n    1,\n    2\n  ]\n}')
  })

  test('leaves non-JSON text unchanged', () => {
    render(<JsonBlock value="plain text" variant="preview" />)
    assert.equal(screen.getByText('plain text').textContent, 'plain text')
  })
})
