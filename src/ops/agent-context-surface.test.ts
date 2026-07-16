import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { z } from 'zod'
import { estimateUtf8Tokens } from '../agent/compaction-token-estimator.js'
import { buildClaudeCodeRequestBody } from '../agent/claude-code/request.js'
import { CLAUDE_CODE_BILLING_HEADER } from '../agent/claude-code/headers.js'
import { buildOpenAIAgentRequest } from '../agent/openai-agent/llm-client.js'
import type { Tool } from '../agent/tool.js'
import {
  AGENT_CONTEXT_SURFACE_SCHEMA_VERSION,
  buildAgentContextSurface,
  readAgentContextSurface,
  writeAgentContextSurface,
} from './agent-context-surface.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('builds the Claude request surface with provider-facing declaration metrics', () => {
  const systemPrompt = 'private bot system prompt'
  const tools = [
    createTool('lookup', 'private lookup description'),
    createTool('send', 'private send description'),
  ]
  const surface = buildAgentContextSurface({
    provider: 'claude-code',
    model: 'claude-opus-4-7',
    contextWindowTokens: 1_000_000,
    systemPrompt,
    tools,
    generatedAt: '2026-07-16T12:00:00.000+08:00',
    pid: 123,
  })
  const request = buildClaudeCodeRequestBody({
    model: 'claude-opus-4-7',
    systemPrompt,
    messages: [],
    tools,
  })
  const declarations = request.tools!.map((declaration) => JSON.stringify(declaration))

  assert.equal(surface.schemaVersion, AGENT_CONTEXT_SURFACE_SCHEMA_VERSION)
  assert.equal(surface.provider, 'claude-code')
  assert.equal(surface.model, 'claude-opus-4-7')
  assert.equal(surface.contextWindowTokens, 1_000_000)
  assert.deepEqual(surface.systemIdentity, measure(CLAUDE_CODE_BILLING_HEADER))
  assert.deepEqual(surface.botSystemPrompt, measure(systemPrompt))
  assert.deepEqual(surface.tools.items, [
    { name: 'lookup', ...measure(declarations[0]!) },
    { name: 'send', ...measure(declarations[1]!) },
  ])
  assert.equal(
    surface.tools.totalBytes,
    surface.tools.items[0]!.bytes + surface.tools.items[1]!.bytes,
  )
  assert.equal(
    surface.tools.totalTokens,
    surface.tools.items[0]!.tokens + surface.tools.items[1]!.tokens,
  )
  assert.match(surface.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(surface.fingerprint, buildAgentContextSurface({
    provider: 'claude-code',
    model: 'claude-opus-4-7',
    contextWindowTokens: 1_000_000,
    systemPrompt,
    tools,
    generatedAt: '2099-01-01T00:00:00.000Z',
    pid: 999,
  }).fingerprint)
})

test('snapshot omits prompt, descriptions, schema property names, and declaration bodies', () => {
  const surface = buildAgentContextSurface({
    provider: 'claude-code',
    model: 'claude-opus-4-7',
    contextWindowTokens: 1_000_000,
    systemPrompt: 'SYSTEM_BODY_MUST_NOT_BE_STORED',
    tools: [createTool('safe_name', 'DESCRIPTION_MUST_NOT_BE_STORED')],
    generatedAt: '2026-07-16T12:00:00.000+08:00',
    pid: 123,
  })
  const raw = JSON.stringify(surface)

  assert.equal(raw.includes('SYSTEM_BODY_MUST_NOT_BE_STORED'), false)
  assert.equal(raw.includes('DESCRIPTION_MUST_NOT_BE_STORED'), false)
  assert.equal(raw.includes('super_secret_argument_name'), false)
  assert.equal(raw.includes('SCHEMA_BODY_MUST_NOT_BE_STORED'), false)
  assert.equal(raw.includes('input_schema'), false)
  assert.equal(raw.includes('properties'), false)
  assert.equal(surface.tools.items[0]!.name, 'safe_name')
})

test('uses different provider-facing declarations for Claude and OpenAI', () => {
  const tool = createTool('lookup', 'lookup description')
  const base = {
    model: 'shared-model',
    contextWindowTokens: 400_000,
    systemPrompt: 'prompt',
    tools: [tool],
    generatedAt: '2026-07-16T12:00:00.000+08:00',
    pid: 123,
  }
  const claude = buildAgentContextSurface({ provider: 'claude-code', ...base })
  const openai = buildAgentContextSurface({ provider: 'openai-agent', ...base })
  const claudeDeclaration = JSON.stringify(buildClaudeCodeRequestBody({
    model: base.model,
    systemPrompt: base.systemPrompt,
    messages: [],
    tools: base.tools,
  }).tools![0])
  const openaiDeclaration = JSON.stringify(buildOpenAIAgentRequest({
    model: base.model,
    systemPrompt: base.systemPrompt,
    messages: [],
    tools: base.tools,
  }).tools![0])

  assert.deepEqual(claude.tools.items[0], { name: tool.name, ...measure(claudeDeclaration) })
  assert.deepEqual(openai.tools.items[0], { name: tool.name, ...measure(openaiDeclaration) })
  assert.notDeepEqual(claude.tools.items[0], openai.tools.items[0])
  assert.deepEqual(openai.systemIdentity, measure(JSON.stringify({ role: 'developer', content: '' })))
  assert.notEqual(claude.fingerprint, openai.fingerprint)
})

test('missing surfaces degrade and written surfaces round-trip', async () => {
  const root = await makeRoot()
  const path = join(root, 'logs/context-surface.json')
  const surface = createSurface()

  assert.deepEqual(await readAgentContextSurface(path), { status: 'missing' })
  await writeAgentContextSurface(path, surface)
  assert.deepEqual(await readAgentContextSurface(path), { status: 'available', surface })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), surface)
})

test('invalid JSON and unsupported schema versions return invalid without throwing', async () => {
  const root = await makeRoot()
  const path = join(root, 'context-surface.json')

  await writeFile(path, '{not-json', 'utf8')
  const invalidJson = await readAgentContextSurface(path)
  assert.equal(invalidJson.status, 'invalid')
  if (invalidJson.status === 'invalid') assert.match(invalidJson.error, /JSON|Unexpected|property/i)

  await writeFile(path, JSON.stringify({ ...createSurface(), schemaVersion: 2 }), 'utf8')
  const unsupportedVersion = await readAgentContextSurface(path)
  assert.equal(unsupportedVersion.status, 'invalid')
  if (unsupportedVersion.status === 'invalid') assert.match(unsupportedVersion.error, /schemaVersion/i)

  await writeFile(path, JSON.stringify({ ...createSurface(), leakedBody: 'nope' }), 'utf8')
  const unknownField = await readAgentContextSurface(path)
  assert.equal(unknownField.status, 'invalid')

  await writeFile(path, JSON.stringify({ ...createSurface(), pid: 0 }), 'utf8')
  const invalidMetadata = await readAgentContextSurface(path)
  assert.equal(invalidMetadata.status, 'invalid')
})

test('atomic writes create parents, replace old data, and leave no temporary file', async () => {
  const root = await makeRoot()
  const directory = join(root, 'nested', 'logs')
  const path = join(directory, 'context-surface.json')
  const first = createSurface()
  const second = { ...createSurface(), generatedAt: '2026-07-16T13:00:00.000+08:00', pid: 456 }

  await writeAgentContextSurface(path, first)
  await writeAgentContextSurface(path, second)

  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), second)
  assert.deepEqual(await readdir(directory), ['context-surface.json'])
})

test('failed atomic replacement removes its temporary file', async () => {
  const root = await makeRoot()
  const directory = join(root, 'logs')
  const path = join(directory, 'context-surface.json')
  await mkdir(path, { recursive: true })

  await assert.rejects(writeAgentContextSurface(path, createSurface()))

  assert.deepEqual(await readdir(directory), ['context-surface.json'])
})

test('fingerprint changes with every request-surface input', () => {
  const tool = createTool('lookup', 'lookup description')
  const base = {
    provider: 'claude-code' as const,
    model: 'claude-opus-4-7',
    contextWindowTokens: 1_000_000,
    systemPrompt: 'prompt',
    tools: [tool],
    generatedAt: '2026-07-16T12:00:00.000+08:00',
    pid: 123,
  }
  const fingerprint = buildAgentContextSurface(base).fingerprint
  const changedInputs = [
    { ...base, model: 'claude-sonnet-4-7' },
    { ...base, contextWindowTokens: 999_999 },
    { ...base, systemPrompt: 'changed prompt' },
    { ...base, tools: [createTool('lookup', 'changed description')] },
    { ...base, tools: [{ ...tool, schema: z.object({ changed_schema: z.boolean() }) }] },
    { ...base, tools: [tool, createTool('send', 'send description')] },
  ]

  for (const input of changedInputs) {
    assert.notEqual(buildAgentContextSurface(input).fingerprint, fingerprint)
  }

  const secondTool = createTool('send', 'send description')
  assert.notEqual(
    buildAgentContextSurface({ ...base, tools: [tool, secondTool] }).fingerprint,
    buildAgentContextSurface({ ...base, tools: [secondTool, tool] }).fingerprint,
  )
})

function createTool(name: string, description: string): Tool {
  return {
    name,
    description,
    schema: z.object({
      super_secret_argument_name: z.string().describe('SCHEMA_BODY_MUST_NOT_BE_STORED'),
      optional_count: z.number().optional(),
    }),
    async execute() {
      return { content: 'ok' }
    },
  }
}

function createSurface() {
  return buildAgentContextSurface({
    provider: 'openai-agent',
    model: 'gpt-5.5',
    contextWindowTokens: 400_000,
    systemPrompt: 'prompt',
    tools: [],
    generatedAt: '2026-07-16T12:00:00.000+08:00',
    pid: 123,
  })
}

function measure(serialized: string): { bytes: number; tokens: number } {
  return {
    bytes: Buffer.byteLength(serialized, 'utf8'),
    tokens: estimateUtf8Tokens(serialized),
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-context-surface-'))
  roots.push(root)
  return root
}
