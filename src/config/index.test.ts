import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseConfig } from './index.js'

function createBaseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    NAPCAT_WS_URL: 'ws://localhost:3001',
    NAPCAT_ACCESS_TOKEN: 'token',
    GROUP_IDS: '123,456',
    SELF_NUMBER: '789',
    LLM_DEFAULT_PROVIDER: 'claude',
    LLM_DEFAULT_MODEL: 'claude-sonnet-4-6',
    LLM_PROVIDER_CLAUDE_URL: 'http://127.0.0.1:8317/v1',
    LLM_PROVIDER_CLAUDE_API_KEY: 'sk-local',
    LLM_PROVIDER_OPENAI_URL: 'http://127.0.0.1:8317/v1',
    LLM_PROVIDER_OPENAI_API_KEY: 'sk-local',
    ...overrides,
  }
}

describe('config', () => {
  test('parses provider registry and scenario provider/model routing', () => {
    const config = parseConfig(createBaseEnv({
      LLM_PROVIDER_GEMINI_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      LLM_PROVIDER_GEMINI_API_KEY: 'gemini-key',
      LLM_SCENARIO_DESCRIBE_IMAGE_PROVIDER: 'gemini',
      LLM_SCENARIO_DESCRIBE_IMAGE_MODEL: 'gemini-3-flash-preview',
      LLM_SCENARIO_DESCRIBE_IMAGE_FALLBACK_PROVIDER: 'openai',
      LLM_SCENARIO_DESCRIBE_IMAGE_FALLBACK_MODEL: 'gpt-5.4',
      LLM_SCENARIO_DESCRIBE_IMAGE_FALLBACK_GPT_STREAM_MODE: 'on',
      LLM_SCENARIO_DESCRIBE_IMAGE_STREAM_MODE: 'fallback',
      LLM_SCENARIO_TRANSCRIBE_AUDIO_PROVIDER: 'gemini',
      LLM_SCENARIO_TRANSCRIBE_AUDIO_MODEL: 'gemini-3-flash-preview',
    }))

    assert.equal(config.llm.defaultProvider, 'claude')
    assert.equal(config.llm.defaultModel, 'claude-sonnet-4-6')
    assert.deepEqual(config.llm.providers.claude, {
      url: 'http://127.0.0.1:8317/v1',
      apiKey: 'sk-local',
    })
    assert.deepEqual(config.llm.providers.openai, {
      url: 'http://127.0.0.1:8317/v1',
      apiKey: 'sk-local',
    })
    assert.deepEqual(config.llm.providers.gemini, {
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: 'gemini-key',
    })
    assert.deepEqual(config.llm.scenarios.describeImage, {
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      fallbackProvider: 'openai',
      fallbackModel: 'gpt-5.4',
      fallbackGptStreamMode: 'on',
      streamMode: 'fallback',
    })
    assert.deepEqual(config.llm.scenarios.transcribeAudio, {
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
    })
  })

  test('defaults image stream mode to off and omits unconfigured scenarios', () => {
    const config = parseConfig(createBaseEnv())

    assert.deepEqual(config.llm.scenarios.describeImage, { streamMode: 'off' })
    assert.deepEqual(config.llm.scenarios.describeVideo, {})
  })

  test('throws when default provider is missing from registry', () => {
    assert.throws(
      () =>
        parseConfig(createBaseEnv({
          LLM_DEFAULT_PROVIDER: 'anthropic',
        })),
      /Missing provider configuration for LLM_DEFAULT_PROVIDER: anthropic/,
    )
  })

  test('throws when scenario points to an unknown provider', () => {
    assert.throws(
      () =>
        parseConfig(createBaseEnv({
          LLM_SCENARIO_DESCRIBE_IMAGE_PROVIDER: 'gemini',
        })),
      /Missing provider configuration for scenario describeImage: gemini/,
    )
  })

  test('throws when image fallback points to an unknown provider', () => {
    assert.throws(
      () =>
        parseConfig(createBaseEnv({
          LLM_SCENARIO_DESCRIBE_IMAGE_FALLBACK_PROVIDER: 'gemini',
        })),
      /Missing fallback provider configuration for scenario describeImage: gemini/,
    )
  })
})
