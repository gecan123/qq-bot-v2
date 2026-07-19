import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runAgentDoctor } from './agent-doctor.js'

const healthyFiles = {
  'AGENTS.md': 'same\n',
  'CLAUDE.md': 'same\n',
  'package.json': '{"scripts":{"repo-check":"tsx scripts/repo-check.ts","agent:doctor":"tsx scripts/agent-doctor.ts","agent:metrics":"tsx scripts/agent-metrics.ts"}}',
  'prisma/schema.prisma': [
    '@@map("bot_agent_ledger_entries")',
    '@@map("bot_agent_runtime_state")',
    '@@map("bot_agent_checkpoint")',
  ].join('\n'),
  '.env.example': 'LLM_DEFAULT_PROVIDER=openai-agent\n',
  'prompts/groups.md': '# 群聊配置\n',
  'src/index.ts': 'createAgentRuntime()\n',
  'src/agent/tools/index.ts': 'buildBotToolManifest\n',
}

const healthyEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  NAPCAT_WS_URL: 'ws://127.0.0.1:3001',
  NAPCAT_ACCESS_TOKEN: 'token',
  SELF_NUMBER: '10001',
  LLM_DEFAULT_PROVIDER: 'openai-agent',
  LLM_DEFAULT_MODEL: 'model',
  LLM_PROVIDER_OPENAI_URL: 'http://127.0.0.1:8317/v1',
  LLM_PROVIDER_OPENAI_API_KEY: 'key',
}

describe('runAgentDoctor', () => {
  test('reports ok when local files and required env are present', () => {
    const result = runAgentDoctor({ files: healthyFiles, env: healthyEnv })

    assert.equal(result.ok, true)
    assert.deepEqual(result.errors, [])
  })

  test('reports missing env without checking external services', () => {
    const result = runAgentDoctor({
      files: healthyFiles,
      env: {
        ...healthyEnv,
        DATABASE_URL: '',
        LLM_PROVIDER_OPENAI_API_KEY: undefined,
      },
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /missing env DATABASE_URL/)
    assert.match(result.errors.join('\n'), /missing env LLM_PROVIDER_OPENAI_API_KEY/)
  })

  test('reports repository map drift', () => {
    const result = runAgentDoctor({
      files: {
        ...healthyFiles,
        'CLAUDE.md': 'different\n',
        'src/agent/tools/index.ts': '',
      },
      env: healthyEnv,
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /AGENTS.md and CLAUDE.md differ/)
    assert.match(result.errors.join('\n'), /src\/agent\/tools\/index\.ts is empty/)
  })
})
