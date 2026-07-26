import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { llmGatewayProviderUrl } from './llm-routing.js'

describe('llmGatewayProviderUrl', () => {
  test('builds a stable provider namespace without duplicating slashes', () => {
    assert.equal(
      llmGatewayProviderUrl('http://127.0.0.1:37926/', 'openai'),
      'http://127.0.0.1:37926/provider/openai',
    )
  })

  test('escapes custom provider names as one path segment', () => {
    assert.equal(
      llmGatewayProviderUrl('http://127.0.0.1:37926', 'local/provider'),
      'http://127.0.0.1:37926/provider/local%2Fprovider',
    )
  })
})
