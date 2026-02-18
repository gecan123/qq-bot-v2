import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { CodeAssistServer } from './gemini-cli-provier.js'

describe('CodeAssistServer', () => {
  test('generateContent returns a response with text', async () => {
    const server = new CodeAssistServer("luna-2-449613")

    const response = await server.generateContent({
      model: 'gemini-2.5-pro',
      contents: [{
        role: 'user',
        parts: [{ text: '用一个词回答：1+1等于几？' }]
      }]
    })

    assert.ok(response, 'response should exist')
    assert.ok(response.candidates, 'candidates should exist')
    assert.ok(response.candidates.length > 0, 'should have at least one candidate')

    const text = response.text
    assert.ok(text, 'response should contain text')
    console.log('Response text:', text)
  })
})
