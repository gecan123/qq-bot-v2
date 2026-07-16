import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { z } from 'zod'
import { CLAUDE_CODE_BILLING_HEADER } from '../agent/claude-code/headers.js'
import { estimateUtf8Tokens } from '../agent/compaction-token-estimator.js'
import type { Tool } from '../agent/tool.js'
import {
  zodToOpenAIStrictToolJsonSchema,
  zodToToolJsonSchema,
} from '../agent/tool-schema.js'
import {
  AGENT_CONTEXT_SURFACE_SCHEMA_VERSION,
  buildAgentContextSurface,
  readAgentContextSurface,
  writeAgentContextSurface,
  writeRuntimeAgentContextSurface,
} from './agent-context-surface.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('builds a minimal Claude fixed-token snapshot', () => {
  const tools = [
    createTool('lookup', 'lookup description'),
    createTool('send', 'send description'),
  ]
  const prompt = 'private system prompt'
  const surface = buildAgentContextSurface({
    provider: 'claude-code',
    model: 'claude-opus-4-7',
    contextWindowTokens: 1_000_000,
    systemPrompt: prompt,
    tools,
    generatedAt: '2026-07-16T12:00:00.000+08:00',
  })
  const declarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: zodToToolJsonSchema(tool.schema),
  }))

  assert.deepEqual(surface, {
    schemaVersion: 2,
    generatedAt: '2026-07-16T12:00:00.000+08:00',
    provider: 'claude-code',
    model: 'claude-opus-4-7',
    contextWindowTokens: 1_000_000,
    fixedTokens: {
      systemIdentity: estimateUtf8Tokens(CLAUDE_CODE_BILLING_HEADER),
      botSystemPrompt: estimateUtf8Tokens(prompt),
      visibleTools: declarations.reduce(
        (sum, declaration) => sum + estimateUtf8Tokens(JSON.stringify(declaration)),
        0,
      ),
    },
  })
  assert.equal(JSON.stringify(surface).includes(prompt), false)
  assert.equal(JSON.stringify(surface).includes('lookup description'), false)
})

test('uses provider-specific tool declarations but stores only totals', () => {
  const tool = createTool('demo', 'demo description')
  const base = {
    model: 'model',
    contextWindowTokens: 400_000,
    systemPrompt: 'prompt',
    tools: [tool],
    generatedAt: '2026-07-16T12:00:00.000+08:00',
  }
  const claude = buildAgentContextSurface({ ...base, provider: 'claude-code' })
  const openai = buildAgentContextSurface({ ...base, provider: 'openai-agent' })
  const openaiDeclaration = {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToOpenAIStrictToolJsonSchema(tool.schema),
      strict: true,
    },
  }

  assert.equal(
    openai.fixedTokens.visibleTools,
    estimateUtf8Tokens(JSON.stringify(openaiDeclaration)),
  )
  assert.notEqual(claude.fixedTokens.visibleTools, openai.fixedTokens.visibleTools)
  assert.equal('bytes' in openai.fixedTokens, false)
  assert.equal('items' in openai.fixedTokens, false)
  assert.equal('fingerprint' in openai, false)
  assert.equal('pid' in openai, false)
})

test('missing files degrade and atomic writes round-trip schema v2', async () => {
  const root = await makeRoot()
  const path = join(root, 'nested', 'context-surface.json')
  const surface = createSurface()

  assert.deepEqual(await readAgentContextSurface(path), { status: 'missing' })
  await writeAgentContextSurface(path, surface)
  assert.deepEqual(await readAgentContextSurface(path), { status: 'available', surface })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), surface)
  assert.deepEqual(await readdir(join(root, 'nested')), ['context-surface.json'])
})

test('invalid JSON and the old schema degrade without throwing', async () => {
  const root = await makeRoot()
  const path = join(root, 'context-surface.json')

  await writeFile(path, '{broken', 'utf8')
  assert.equal((await readAgentContextSurface(path)).status, 'invalid')

  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-07-16T12:00:00.000+08:00',
    pid: 123,
  }), 'utf8')
  assert.equal((await readAgentContextSurface(path)).status, 'invalid')
})

test('runtime writer adds Beijing time and persists the same snapshot', async () => {
  const root = await makeRoot()
  const path = join(root, 'context-surface.json')
  const surface = await writeRuntimeAgentContextSurface({
    path,
    provider: 'claude-code',
    model: 'claude-opus-4-7',
    contextWindowTokens: 1_000_000,
    systemPrompt: 'prompt',
    tools: [createTool('demo', 'description')],
    now: () => new Date('2026-07-16T04:00:00.123Z'),
  })

  assert.equal(surface.generatedAt, '2026-07-16T12:00:00.123+08:00')
  assert.deepEqual(await readAgentContextSurface(path), { status: 'available', surface })
})

test('startup writes only the simplified surface before starting the lifecycle', async () => {
  const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8')
  const writeIndex = source.indexOf('await writeRuntimeAgentContextSurface({')
  const lifecycleIndex = source.indexOf('const agentLifecycle = createAgentStartupLifecycle({')
  const wiring = source.slice(writeIndex, lifecycleIndex)

  assert.ok(writeIndex >= 0)
  assert.ok(lifecycleIndex > writeIndex)
  assert.match(wiring, /runtime\.systemPrompt/)
  assert.match(wiring, /runtime\.tools\.list\(\)/)
  assert.doesNotMatch(wiring, /fingerprint/)
  assert.doesNotMatch(wiring, /pid/)
})

function createTool(name: string, description: string): Tool {
  return {
    name,
    description,
    schema: z.object({ query: z.string() }),
    async execute() {
      return { content: 'ok' }
    },
  }
}

function createSurface() {
  return buildAgentContextSurface({
    provider: 'openai-agent',
    model: 'gpt-test',
    contextWindowTokens: 400_000,
    systemPrompt: 'prompt',
    tools: [],
    generatedAt: '2026-07-16T12:00:00.000+08:00',
  })
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-context-surface-'))
  roots.push(root)
  return root
}
