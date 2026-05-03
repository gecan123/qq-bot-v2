import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseConfig, parseIdList } from './index.js'

function createBaseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    NAPCAT_WS_URL: 'ws://localhost:3001',
    NAPCAT_ACCESS_TOKEN: 'token',
    BOT_TARGET_GROUP_IDS: '123',
    BOT_TARGET_PRIVATE_USER_IDS: '',
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
  })

  test('defaults image stream mode to off and omits unconfigured scenarios', () => {
    const config = parseConfig(createBaseEnv())

    assert.deepEqual(config.llm.scenarios.describeImage, { streamMode: 'off' })
    assert.deepEqual(config.llm.scenarios.describeVideo, {})
    assert.deepEqual(config.botTargetGroupIds, [123])
    assert.deepEqual(config.botTargetPrivateUserIds, [])
    assert.equal(config.selfNumber, 789)
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

  test('throws when both whitelists are empty', () => {
    assert.throws(
      () =>
        parseConfig(createBaseEnv({
          BOT_TARGET_GROUP_IDS: '',
          BOT_TARGET_PRIVATE_USER_IDS: '',
        })),
      /both empty/,
    )
  })

  test('parses both group and private whitelists, sorted + deduped', () => {
    const config = parseConfig(createBaseEnv({
      BOT_TARGET_GROUP_IDS: '222,111,222',
      BOT_TARGET_PRIVATE_USER_IDS: '20002, 10001',
    }))
    assert.deepEqual(config.botTargetGroupIds, [111, 222])
    assert.deepEqual(config.botTargetPrivateUserIds, [10001, 20002])
  })

  test('private-only whitelist is allowed (no group required)', () => {
    const config = parseConfig(createBaseEnv({
      BOT_TARGET_GROUP_IDS: '',
      BOT_TARGET_PRIVATE_USER_IDS: '10001',
    }))
    assert.deepEqual(config.botTargetGroupIds, [])
    assert.deepEqual(config.botTargetPrivateUserIds, [10001])
  })

  test('compactionTriggerTokens defaults to 16_000 and accepts override', () => {
    const dflt = parseConfig(createBaseEnv())
    assert.equal(dflt.compactionTriggerTokens, 16_000)

    const override = parseConfig(createBaseEnv({
      COMPACTION_TRIGGER_TOKENS: '24000',
    }))
    assert.equal(override.compactionTriggerTokens, 24_000)
  })
})

describe('parseIdList', () => {
  test('parses comma-separated numbers, trims whitespace, drops empties', () => {
    assert.deepEqual(parseIdList('X', '111, 222 ,, 333  '), [111, 222, 333])
  })

  test('dedupes and sorts ascending', () => {
    assert.deepEqual(parseIdList('X', '333,111,222,111'), [111, 222, 333])
  })

  test('accepts a single ID with no trailing comma', () => {
    assert.deepEqual(parseIdList('X', '999'), [999])
  })

  test('treats undefined / empty / whitespace-only as empty list', () => {
    assert.deepEqual(parseIdList('X', undefined), [])
    assert.deepEqual(parseIdList('X', ''), [])
    assert.deepEqual(parseIdList('X', ' , , '), [])
  })

  test('throws on non-numeric segments', () => {
    assert.throws(() => parseIdList('Y', '111,abc,222'), /Invalid id "abc" in env Y/)
  })

  test('throws on float-like segments (must be integer)', () => {
    assert.throws(() => parseIdList('Z', '111.5'), /Invalid id "111\.5" in env Z/)
  })
})
