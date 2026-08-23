import { describe, expect, test } from 'vitest'
import { createMetricsWindow } from './metrics-window.js'

describe('createMetricsWindow', () => {
  test('uses seven complete Beijing calendar labels ending today', () => {
    const window = createMetricsWindow(new Date('2026-08-23T04:00:00.000Z'))

    expect(window.from.toISOString()).toBe('2026-08-16T16:00:00.000Z')
    expect(window.to.toISOString()).toBe('2026-08-23T04:00:00.000Z')
    expect(window.days).toEqual([
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
    ])
  })

  test('keeps the Beijing date across the UTC day boundary', () => {
    const window = createMetricsWindow(new Date('2026-08-22T16:30:00.000Z'))

    expect(window.days.at(-1)).toBe('2026-08-23')
    expect(window.from.toISOString()).toBe('2026-08-16T16:00:00.000Z')
  })
})
