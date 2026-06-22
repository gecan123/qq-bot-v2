import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runRepoChecks } from './repo-check.js'

const validFiles = {
  'AGENTS.md': [
    '# Repository Agent Instructions',
    '',
    'Read `docs/README.md` for the repository knowledge map.',
    'Read `docs/AGENT_CONTEXT.md` before changing persistent context.',
  ].join('\n'),
  'CLAUDE.md': [
    '# Repository Agent Instructions',
    '',
    'Read `docs/README.md` for the repository knowledge map.',
    'Read `docs/AGENT_CONTEXT.md` before changing persistent context.',
  ].join('\n'),
  'README.md': [
    '# qq-bot-v2',
    '',
    'Uses `bot_agent_snapshot` for the single persistent AgentContext.',
    'Run `pnpm repo-check` before handing work back.',
  ].join('\n'),
  'package.json': JSON.stringify({
    scripts: {
      'repo-check': 'tsx scripts/repo-check.ts',
      'agent:doctor': 'tsx scripts/agent-doctor.ts',
      'agent:metrics': 'tsx scripts/agent-metrics.ts',
      lint: 'pnpm typecheck && pnpm repo-check',
    },
  }),
  'prisma/schema.prisma': 'model BotAgentSnapshot {\n  @@map("bot_agent_snapshot")\n}\n',
  'docs/README.md': 'docs/ARCHITECTURE.md\ndocs/AGENT_CONTEXT.md\ndocs/TOOLS.md\ndocs/OPERATIONS.md\ndocs/TECH_DEBT.md\n',
  'docs/ARCHITECTURE.md': '# Architecture\n',
  'docs/AGENT_CONTEXT.md': '# Persistent Agent Context\n',
  'docs/TOOLS.md': '# Agent Tools\n',
  'docs/OPERATIONS.md': '# Operations\n',
  'docs/TECH_DEBT.md': '# Technical Debt\n',
}

describe('runRepoChecks', () => {
  test('accepts mirrored agent instructions and current repository map', () => {
    const result = runRepoChecks(validFiles)

    assert.deepEqual(result.errors, [])
  })

  test('rejects stale README references to removed architecture surfaces', () => {
    const result = runRepoChecks({
      ...validFiles,
      'README.md': 'Use scene_agent_contexts and reply_records in admin-web.',
    })

    assert.match(result.errors.join('\n'), /README\.md references removed surface "scene_agent_contexts"/)
    assert.match(result.errors.join('\n'), /README\.md references removed surface "reply_records"/)
    assert.match(result.errors.join('\n'), /README\.md references removed surface "admin-web"/)
  })

  test('rejects package scripts that do not expose repo-check through lint', () => {
    const result = runRepoChecks({
      ...validFiles,
      'package.json': JSON.stringify({
        scripts: {
          lint: 'pnpm typecheck',
        },
      }),
    })

    assert.match(result.errors.join('\n'), /package\.json must define scripts\["repo-check"\]/)
    assert.match(result.errors.join('\n'), /package\.json scripts\.lint must run repo-check/)
  })

  test('rejects missing operational feedback scripts', () => {
    const result = runRepoChecks({
      ...validFiles,
      'package.json': JSON.stringify({
        scripts: {
          'repo-check': 'tsx scripts/repo-check.ts',
          lint: 'pnpm typecheck && pnpm repo-check',
        },
      }),
    })

    assert.match(result.errors.join('\n'), /package\.json must define scripts\["agent:doctor"\]/)
    assert.match(result.errors.join('\n'), /package\.json must define scripts\["agent:metrics"\]/)
  })

  test('rejects stale README environment variable names', () => {
    const result = runRepoChecks({
      ...validFiles,
      'README.md': 'Configure `GROUP_IDS` before startup. Uses `bot_agent_snapshot`.',
    })

    assert.match(result.errors.join('\n'), /README\.md references stale env var "GROUP_IDS"/)
  })

  test('rejects oversized agent entry files and missing docs links', () => {
    const longEntry = Array.from({ length: 121 }, (_, i) => `line ${i}`).join('\n')
    const result = runRepoChecks({
      ...validFiles,
      'AGENTS.md': longEntry,
      'CLAUDE.md': longEntry,
    })

    assert.match(result.errors.join('\n'), /AGENTS\.md should stay short/)
    assert.match(result.errors.join('\n'), /AGENTS\.md must link docs\/README\.md/)
    assert.match(result.errors.join('\n'), /AGENTS\.md must link docs\/AGENT_CONTEXT\.md/)
  })

  test('rejects missing required documentation map entries', () => {
    const result = runRepoChecks({
      ...validFiles,
      'docs/README.md': 'docs/ARCHITECTURE.md\n',
      'docs/TOOLS.md': '',
    })

    assert.match(result.errors.join('\n'), /docs\/README\.md must link docs\/AGENT_CONTEXT\.md/)
    assert.match(result.errors.join('\n'), /docs\/TOOLS\.md must not be empty/)
  })
})
