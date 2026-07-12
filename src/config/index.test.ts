import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

function createBaseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    NAPCAT_WS_URL: 'ws://localhost:3001',
    NAPCAT_ACCESS_TOKEN: 'token',
    BOT_TARGET_GROUP_IDS: '123',
    SELF_NUMBER: '789',
    LLM_DEFAULT_PROVIDER: 'claude-code',
    LLM_DEFAULT_MODEL: 'claude-sonnet-4-6',
    LLM_PROVIDER_CLAUDE_URL: 'http://127.0.0.1:8317/v1',
    LLM_PROVIDER_CLAUDE_API_KEY: 'sk-local',
    LLM_PROVIDER_OPENAI_URL: 'http://127.0.0.1:8317/v1',
    LLM_PROVIDER_OPENAI_API_KEY: 'sk-local',
    ...overrides,
  }
}

const importEnv = createBaseEnv()
const originalImportEnv = new Map(
  Object.keys(importEnv).map((key) => [key, process.env[key]]),
)

Object.assign(process.env, importEnv)
let configModule: typeof import('./index.js') | undefined
try {
  configModule = await import('./index.js')
} finally {
  for (const key of Object.keys(importEnv)) {
    const originalValue = originalImportEnv.get(key)
    if (originalValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalValue
    }
  }
}

if (!configModule) throw new Error('Failed to import config module')
const { parseConfig, parseIdList } = configModule

describe('config', () => {
  test('parses provider registry and scenario provider/model routing', () => {
    const config = parseConfig(createBaseEnv({
      LLM_PROVIDER_GEMINI_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      LLM_PROVIDER_GEMINI_API_KEY: 'gemini-key',
      LLM_SCENARIO_DESCRIBE_IMAGE_PROVIDER: 'gemini',
      LLM_SCENARIO_DESCRIBE_IMAGE_MODEL: 'gemini-3-flash-preview',
      LLM_SCENARIO_DESCRIBE_IMAGE_REASONING_EFFORT: 'low',
      LLM_SCENARIO_TRANSCRIBE_AUDIO_PROVIDER: 'gemini',
      LLM_SCENARIO_TRANSCRIBE_AUDIO_MODEL: 'gemini-3-flash-preview',
    }))

    assert.equal(config.llm.defaultProvider, 'claude-code')
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
      reasoningEffort: 'low',
    })
  })

  test('rejects unsupported scenario reasoning effort', () => {
    assert.throws(
      () => parseConfig(createBaseEnv({
        LLM_SCENARIO_DESCRIBE_IMAGE_REASONING_EFFORT: 'ultra',
      })),
      /LLM_SCENARIO_DESCRIBE_IMAGE_REASONING_EFFORT/,
    )
  })

  test('parses Claude tool choice override for Anthropic-compatible providers', () => {
    const config = parseConfig(createBaseEnv({
      LLM_PROVIDER_CLAUDE_TOOL_CHOICE: 'auto',
    }))

    assert.equal(config.llm.claudeToolChoice, 'auto')
  })

  test('defaults Claude tool choice to any and rejects unsupported values', () => {
    assert.equal(parseConfig(createBaseEnv()).llm.claudeToolChoice, 'any')
    assert.throws(
      () => parseConfig(createBaseEnv({
        LLM_PROVIDER_CLAUDE_TOOL_CHOICE: 'required',
      })),
      /LLM_PROVIDER_CLAUDE_TOOL_CHOICE/,
    )
  })

  test('defaults Claude thinking toggles to disabled active-tool-cycle off', () => {
    const config = parseConfig(createBaseEnv())

    assert.deepEqual(config.llm.claudeThinking, {
      mode: 'disabled',
      retention: 'active-tool-cycle',
      log: 'off',
    })
  })

  test('parses Claude thinking toggle overrides', () => {
    const config = parseConfig(createBaseEnv({
      LLM_PROVIDER_CLAUDE_THINKING: 'adaptive',
      LLM_PROVIDER_CLAUDE_THINKING_PROMPT_RETENTION: 'always',
      LLM_PROVIDER_CLAUDE_THINKING_LOG: 'raw',
    }))

    assert.deepEqual(config.llm.claudeThinking, {
      mode: 'adaptive',
      retention: 'always',
      log: 'raw',
    })
  })

  test('rejects invalid Claude thinking toggle values', () => {
    assert.throws(
      () => parseConfig(createBaseEnv({
        LLM_PROVIDER_CLAUDE_THINKING: 'on',
      })),
      /LLM_PROVIDER_CLAUDE_THINKING/,
    )
    assert.throws(
      () => parseConfig(createBaseEnv({
        LLM_PROVIDER_CLAUDE_THINKING_PROMPT_RETENTION: 'forever',
      })),
      /LLM_PROVIDER_CLAUDE_THINKING_PROMPT_RETENTION/,
    )
    assert.throws(
      () => parseConfig(createBaseEnv({
        LLM_PROVIDER_CLAUDE_THINKING_LOG: 'verbose',
      })),
      /LLM_PROVIDER_CLAUDE_THINKING_LOG/,
    )
  })

  test('omits unconfigured scenarios entirely', () => {
    const config = parseConfig(createBaseEnv())

    assert.deepEqual(config.llm.scenarios.describeImage, {})
    assert.deepEqual(config.llm.scenarios.describeVideo, {})
    assert.deepEqual(config.botTargetGroupIds, [123])
    assert.equal(config.selfNumber, 789)
  })

  test('parses openai-agent as a supported main agent provider', () => {
    const config = parseConfig(createBaseEnv({
      LLM_DEFAULT_PROVIDER: 'openai-agent',
      LLM_DEFAULT_MODEL: 'gpt-5.1',
    }))

    assert.equal(config.llm.defaultProvider, 'openai-agent')
    assert.equal(config.llm.defaultModel, 'gpt-5.1')
    assert.deepEqual(config.llm.providers.openai, {
      url: 'http://127.0.0.1:8317/v1',
      apiKey: 'sk-local',
    })
  })

  test('throws when default provider is not an agent provider', () => {
    assert.throws(
      () =>
        parseConfig(createBaseEnv({
          LLM_DEFAULT_PROVIDER: 'anthropic',
        })),
      /Unsupported LLM_DEFAULT_PROVIDER: anthropic/,
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

  test('parses group whitelist, sorted + deduped', () => {
    const config = parseConfig(createBaseEnv({
      BOT_TARGET_GROUP_IDS: '222,111,222',
    }))
    assert.deepEqual(config.botTargetGroupIds, [111, 222])
  })

  test('empty group whitelist is allowed (private 永远在线)', () => {
    const config = parseConfig(createBaseEnv({
      BOT_TARGET_GROUP_IDS: '',
    }))
    assert.deepEqual(config.botTargetGroupIds, [])
  })

  test('rejects SELF_NUMBER values that are not positive safe integers', () => {
    for (const value of ['abc', '0', '-1', '9007199254740992']) {
      assert.throws(
        () => parseConfig(createBaseEnv({ SELF_NUMBER: value })),
        /Invalid SELF_NUMBER/,
      )
    }
  })

  test('groupAmbientSendIds defaults to empty set and parses comma-separated ids', () => {
    const dflt = parseConfig(createBaseEnv())
    assert.deepEqual(dflt.groupAmbientSendIds, new Set<number>())

    const config = parseConfig(createBaseEnv({ BOT_GROUP_AMBIENT_SEND_IDS: '111,222,333' }))
    assert.deepEqual(config.groupAmbientSendIds, new Set([111, 222, 333]))
  })

  test('owner: 都不给 → null', () => {
    const config = parseConfig(createBaseEnv())
    assert.equal(config.owner, null)
  })

  test('owner: 都给 → 解析成 { qq, name }', () => {
    const config = parseConfig(createBaseEnv({
      BOT_OWNER_QQ: '3916147294',
      BOT_OWNER_NAME: 'zzz',
    }))
    assert.deepEqual(config.owner, { qq: 3916147294, name: 'zzz' })
  })

  test('owner: 双空字符串 → null (跟未设置等价)', () => {
    const config = parseConfig(createBaseEnv({
      BOT_OWNER_QQ: '',
      BOT_OWNER_NAME: '',
    }))
    assert.equal(config.owner, null)
  })

  test('owner: 只给 QQ 没给 name → throw', () => {
    assert.throws(
      () => parseConfig(createBaseEnv({ BOT_OWNER_QQ: '3916147294' })),
      /BOT_OWNER_QQ and BOT_OWNER_NAME must be set together/,
    )
  })

  test('owner: 只给 name 没给 QQ → throw', () => {
    assert.throws(
      () => parseConfig(createBaseEnv({ BOT_OWNER_NAME: 'zzz' })),
      /BOT_OWNER_QQ and BOT_OWNER_NAME must be set together/,
    )
  })

  test('owner: QQ 是非数字 → throw', () => {
    assert.throws(
      () => parseConfig(createBaseEnv({
        BOT_OWNER_QQ: 'abc',
        BOT_OWNER_NAME: 'zzz',
      })),
      /Invalid BOT_OWNER_QQ "abc"/,
    )
  })

  test('owner: QQ 是浮点 → throw (必须整数)', () => {
    assert.throws(
      () => parseConfig(createBaseEnv({
        BOT_OWNER_QQ: '123.5',
        BOT_OWNER_NAME: 'zzz',
      })),
      /Invalid BOT_OWNER_QQ "123\.5"/,
    )
  })

  test('owner: name 含空格在前后会被 trim', () => {
    const config = parseConfig(createBaseEnv({
      BOT_OWNER_QQ: '  100  ',
      BOT_OWNER_NAME: '  alice  ',
    }))
    assert.deepEqual(config.owner, { qq: 100, name: 'alice' })
  })

  test('toolCallLogPath defaults to logs/tool-calls.ndjson and accepts override', () => {
    const dflt = parseConfig(createBaseEnv())
    assert.equal(dflt.toolCallLogPath, 'logs/tool-calls.ndjson')

    const override = parseConfig(createBaseEnv({
      BOT_TOOL_CALL_LOG_PATH: '/tmp/tool-calls.ndjson',
    }))
    assert.equal(override.toolCallLogPath, '/tmp/tool-calls.ndjson')

    const blank = parseConfig(createBaseEnv({ BOT_TOOL_CALL_LOG_PATH: '   ' }))
    assert.equal(blank.toolCallLogPath, 'logs/tool-calls.ndjson')
  })

  test('openbb: 不启用 OPENBB_CLI_ENABLED → undefined', () => {
    const config = parseConfig(createBaseEnv())
    assert.equal(config.openbb, undefined)
  })

  test('openbb: 启用 OPENBB_CLI_ENABLED → { cliBin, cliTimeoutMs }', () => {
    const config = parseConfig(createBaseEnv({
      OPENBB_CLI_ENABLED: 'true',
      OPENBB_CLI_BIN: '  python3 -m openbb  ',
      OPENBB_CLI_TIMEOUT_MS: '30000',
    }))
    assert.deepEqual(config.openbb, { cliBin: 'python3 -m openbb', cliTimeoutMs: 30_000 })
  })

  test('openbb: OPENBB_CLI_TIMEOUT_MS 非法时回退默认 15000', () => {
    const config = parseConfig(createBaseEnv({
      OPENBB_CLI_ENABLED: '1',
      OPENBB_CLI_TIMEOUT_MS: 'nope',
    }))
    assert.deepEqual(config.openbb, { cliBin: 'openbb', cliTimeoutMs: 15_000 })
  })

  test('vibe trading: 默认关闭，启用时只接受 loopback HTTP origin', () => {
    assert.equal(parseConfig(createBaseEnv()).vibeTrading, undefined)

    const config = parseConfig(createBaseEnv({
      VIBE_TRADING_ENABLED: 'true',
      VIBE_TRADING_BASE_URL: 'http://localhost:8899/',
      VIBE_TRADING_API_KEY: 'local-secret',
      VIBE_TRADING_REQUEST_TIMEOUT_MS: '12000',
      VIBE_TRADING_TASK_TIMEOUT_MS: '900000',
      VIBE_TRADING_POLL_INTERVAL_MS: '1500',
      VIBE_TRADING_RESULT_MAX_CHARS: '20000',
    }))
    assert.deepEqual(config.vibeTrading, {
      baseUrl: 'http://localhost:8899',
      apiKey: 'local-secret',
      requestTimeoutMs: 12_000,
      taskTimeoutMs: 900_000,
      pollIntervalMs: 1_500,
      resultMaxChars: 20_000,
    })

    for (const baseUrl of [
      'https://127.0.0.1:8899',
      'http://example.com:8899',
      'http://127.0.0.1:8899/api',
      'http://user:pass@127.0.0.1:8899',
    ]) {
      assert.throws(
        () => parseConfig(createBaseEnv({ VIBE_TRADING_ENABLED: 'true', VIBE_TRADING_BASE_URL: baseUrl })),
        /VIBE_TRADING_BASE_URL/,
        baseUrl,
      )
    }
  })

  test('moomoo: 默认关闭, 启用时解析受控 Skill runner 配置', () => {
    assert.equal(parseConfig(createBaseEnv()).moomoo, undefined)

    const config = parseConfig(createBaseEnv({
      MOOMOO_SKILL_ENABLED: 'true',
      MOOMOO_SKILL_DIR: '  /Users/test/moomooapi  ',
      MOOMOO_PYTHON_BIN: '  /Users/test/.venv/bin/python3  ',
      MOOMOO_OPEND_PORT: '12345',
      MOOMOO_SKILL_TIMEOUT_MS: '30000',
    }))
    assert.deepEqual(config.moomoo, {
      skillDir: '/Users/test/moomooapi',
      pythonBin: '/Users/test/.venv/bin/python3',
      opendPort: 12_345,
      timeoutMs: 30_000,
    })
  })

  test('moomoo: 启用时必须配置 Skill 绝对目录', () => {
    assert.throws(
      () => parseConfig(createBaseEnv({ MOOMOO_SKILL_ENABLED: 'true' })),
      /MOOMOO_SKILL_DIR is required when MOOMOO_SKILL_ENABLED=true/,
    )
    assert.throws(
      () => parseConfig(createBaseEnv({
        MOOMOO_SKILL_ENABLED: 'true',
        MOOMOO_SKILL_DIR: 'relative/moomooapi',
      })),
      /MOOMOO_SKILL_DIR must be an absolute path/,
    )
  })

  test('crypto paper: 默认关闭，启用时解析初始资金和手续费', () => {
    assert.equal(parseConfig(createBaseEnv()).cryptoPaper, undefined)
    assert.deepEqual(parseConfig(createBaseEnv({
      CRYPTO_PAPER_ENABLED: 'true',
      CRYPTO_PAPER_INITIAL_CASH: '250000.5',
      CRYPTO_PAPER_FEE_RATE_BPS: '8',
    })).cryptoPaper, {
      initialCash: 250_000.5,
      feeRateBps: 8,
    })
  })

  test('crypto paper: 拒绝非法初始资金和手续费', () => {
    assert.throws(
      () => parseConfig(createBaseEnv({ CRYPTO_PAPER_ENABLED: 'true', CRYPTO_PAPER_INITIAL_CASH: '0' })),
      /CRYPTO_PAPER_INITIAL_CASH/,
    )
    assert.throws(
      () => parseConfig(createBaseEnv({ CRYPTO_PAPER_ENABLED: 'true', CRYPTO_PAPER_FEE_RATE_BPS: '-1' })),
      /CRYPTO_PAPER_FEE_RATE_BPS/,
    )
    assert.throws(
      () => parseConfig(createBaseEnv({ CRYPTO_PAPER_ENABLED: 'true', CRYPTO_PAPER_FEE_RATE_BPS: '8.5' })),
      /CRYPTO_PAPER_FEE_RATE_BPS/,
    )
  })

  test('website capability is disabled by default', () => {
    const config = parseConfig(createBaseEnv())

    assert.equal(config.website, undefined)
  })

  test('parses website capability config when enabled', () => {
    const config = parseConfig(createBaseEnv({
      BOT_WEBSITE_ENABLED: 'true',
      BOT_WEBSITE_REPO_DIR: '/Users/zzz/WebstormProjects/luna-site',
      BOT_WEBSITE_PUBLIC_URL: 'https://luna.example.com',
      BOT_WEBSITE_BRANCH: 'main',
      BOT_WEBSITE_CHECK_COMMAND: 'pnpm build',
      BOT_WEBSITE_COMMAND_TIMEOUT_MS: '45000',
    }))

    assert.deepEqual(config.website, {
      repoDir: '/Users/zzz/WebstormProjects/luna-site',
      publicUrl: 'https://luna.example.com',
      branch: 'main',
      checkCommand: 'pnpm build',
      commandTimeoutMs: 45_000,
    })
  })

  test('website config requires repo dir when enabled', () => {
    assert.throws(
      () => parseConfig(createBaseEnv({
        BOT_WEBSITE_ENABLED: 'true',
        BOT_WEBSITE_PUBLIC_URL: 'https://luna.example.com',
      })),
      /BOT_WEBSITE_REPO_DIR is required when BOT_WEBSITE_ENABLED=true/,
    )
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

  test('throws on non-positive or unsafe integer ids', () => {
    for (const value of ['0', '-1', '9007199254740992']) {
      assert.throws(
        () => parseIdList('BOT_TARGET_GROUP_IDS', `111,${value}`),
        /Invalid id/,
      )
    }
  })
})
