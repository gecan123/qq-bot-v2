import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyBrowserActionRisk, classifyDownload, redactBrowserValue } from './risk.js'

describe('classifyBrowserActionRisk', () => {
  it('allows routine human checks', () => {
    const risk = classifyBrowserActionRisk({
      action: 'click',
      element: { elementId: 'e1', role: 'button', label: 'I am human', tagName: 'button' },
    })
    assert.equal(risk.level, 'low')
    assert.equal(risk.requiresOwnerHelp, false)
  })

  it('allows normal posting actions with audit-level risk', () => {
    const risk = classifyBrowserActionRisk({
      action: 'click',
      element: { elementId: 'e1', role: 'button', label: 'Post comment', tagName: 'button' },
    })
    assert.equal(risk.level, 'normal')
    assert.equal(risk.requiresOwnerHelp, false)
  })

  it('blocks payment, oauth, and account security actions', () => {
    for (const label of ['Pay now', 'Connect OAuth app', 'Change password']) {
      const risk = classifyBrowserActionRisk({
        action: 'click',
        element: { elementId: 'e1', role: 'button', label, tagName: 'button' },
      })
      assert.equal(risk.level, 'high', label)
      assert.equal(risk.requiresOwnerHelp, true, label)
    }
  })

  it('blocks typing into sensitive fields', () => {
    const risk = classifyBrowserActionRisk({
      action: 'type',
      element: { elementId: 'e1', role: 'textbox', label: 'Two-factor code', tagName: 'input' },
    })
    assert.equal(risk.level, 'high')
    assert.equal(risk.requiresOwnerHelp, true)
  })
})

describe('classifyDownload', () => {
  it('blocks executable and archive-like downloads', () => {
    for (const fileName of ['setup.dmg', 'installer.exe', 'run.sh', 'archive.zip']) {
      assert.equal(classifyDownload(fileName).level, 'high', fileName)
    }
  })

  it('allows normal documents', () => {
    assert.equal(classifyDownload('paper.pdf', 'application/pdf').level, 'normal')
    assert.equal(classifyDownload('data.csv', 'text/csv').level, 'normal')
  })
})

describe('redactBrowserValue', () => {
  it('redacts sensitive keys deeply', () => {
    const redacted = redactBrowserValue({
      text: 'hello',
      password: 'secret',
      nested: { cookie: 'abc' },
    }) as Record<string, unknown>
    assert.equal(redacted.text, 'hello')
    assert.equal(redacted.password, '[REDACTED]')
    assert.deepEqual(redacted.nested, { cookie: '[REDACTED]' })
  })
})
