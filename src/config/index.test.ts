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
    assert.equal(config.botReplyDryRun, false)
    assert.equal(config.runtimeContextFallback, 'runtime')
    assert.equal(config.runtimeSchedulerTickMs, 0)
  })

  test('parses runtime context fallback and scheduler tick interval', () => {
    const config = parseConfig(createBaseEnv({
      RUNTIME_CONTEXT_FALLBACK: 'ledger',
      RUNTIME_SCHEDULER_TICK_MS: '30000',
    }))
    const invalid = parseConfig(createBaseEnv({
      RUNTIME_CONTEXT_FALLBACK: 'unknown',
      RUNTIME_SCHEDULER_TICK_MS: '-1',
    }))

    assert.equal(config.runtimeContextFallback, 'ledger')
    assert.equal(config.runtimeSchedulerTickMs, 30000)
    assert.equal(invalid.runtimeContextFallback, 'runtime')
    assert.equal(invalid.runtimeSchedulerTickMs, 0)
  })

  test('parses V2EX read-only forum polling config', () => {
    const config = parseConfig(createBaseEnv({
      V2EX_FORUM_ENABLED: 'true',
      V2EX_FORUM_FEEDS: 'latest,node:programmer,tab:tech,member:Livid',
      V2EX_FORUM_POLL_INTERVAL_MS: '600000',
      V2EX_FORUM_MAX_ITEMS_PER_FEED: '5',
      V2EX_FORUM_TIMEOUT_MS: '2500',
      V2EX_FORUM_USER_AGENT: 'qq-bot-v2 test',
      V2EX_FORUM_INTEREST_KEYWORDS: 'claude,agent,编程',
      V2EX_FORUM_FETCH_DETAILS: 'false',
      V2EX_FORUM_DETAIL_REPLY_LIMIT: '3',
    }))

    assert.equal(config.v2exForum.enabled, true)
    assert.deepEqual(config.v2exForum.feeds, ['latest', 'node:programmer', 'tab:tech', 'member:Livid'])
    assert.equal(config.v2exForum.pollIntervalMs, 600000)
    assert.equal(config.v2exForum.maxItemsPerFeed, 5)
    assert.equal(config.v2exForum.timeoutMs, 2500)
    assert.equal(config.v2exForum.userAgent, 'qq-bot-v2 test')
    assert.deepEqual(config.v2exForum.interestKeywords, ['claude', 'agent', '编程'])
    assert.equal(config.v2exForum.fetchDetails, false)
    assert.equal(config.v2exForum.detailReplyLimit, 3)
  })

  test('parses BOT_REPLY_DRY_RUN', () => {
    const enabled = parseConfig(createBaseEnv({ BOT_REPLY_DRY_RUN: 'true' }))
    const disabled = parseConfig(createBaseEnv({ BOT_REPLY_DRY_RUN: 'false' }))

    assert.equal(enabled.botReplyDryRun, true)
    assert.equal(disabled.botReplyDryRun, false)
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
