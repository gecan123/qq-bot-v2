import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  investigationNavigation,
  managementNavigation,
  primaryNavigation,
} from './admin-navigation.js'

describe('AdminShell navigation', () => {
  test('keeps daily destinations small and groups technical evidence separately', () => {
    assert.deepEqual(primaryNavigation.map(item => item.label), ['现在', '会话', '知识'])
    assert.deepEqual(investigationNavigation.map(item => item.to), [
      '/health',
      '/logs',
      '/timeline',
      '/context',
      '/life',
      '/metrics',
    ])
    assert.deepEqual(managementNavigation.map(item => item.to), ['/operations'])
  })
})
