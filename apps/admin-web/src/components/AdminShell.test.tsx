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
    assert.deepEqual(
      investigationNavigation.map(item => ({ to: item.to, label: item.label, hint: item.hint })),
      [
        { to: '/health', label: '系统健康', hint: '完整性与运行状态' },
        { to: '/logs', label: '进程日志', hint: '搜索与实时 tail' },
        { to: '/context', label: 'Agent 历史', hint: '决定后续上下文的正式记录' },
        { to: '/timeline', label: '执行追踪', hint: '模型、工具与 Ledger 诊断' },
        { to: '/life', label: '计划', hint: 'Schedule 与后台任务' },
        { to: '/metrics', label: '用量指标', hint: 'Token、缓存与工具' },
      ],
    )
    assert.deepEqual(managementNavigation.map(item => item.to), ['/operations'])
  })
})
