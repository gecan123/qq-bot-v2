// Keep unit tests deterministic and independent from a developer's local .env.
process.env.DOTENV_CONFIG_PATH = '/dev/null'

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/qq_bot_v2_test',
  NAPCAT_WS_URL: 'ws://127.0.0.1:3001',
  NAPCAT_ACCESS_TOKEN: 'test-token',
  BOT_TARGET_GROUP_IDS: '123',
  SELF_NUMBER: '789',
  LLM_DEFAULT_PROVIDER: 'openai-agent',
  LLM_DEFAULT_MODEL: 'test-model',
  LLM_PROVIDER_OPENAI_URL: 'http://127.0.0.1:8317/v1',
  LLM_PROVIDER_OPENAI_API_KEY: 'test-key',
})
