import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createGhTool, normalizeGhRepository, type GhRunner } from './gh.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import { classifyBotToolPolicy } from './policies.js'

const ctx = { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }

function makeTool(runner: GhRunner) {
  return createGhTool({ runner, executable: '/opt/homebrew/bin/gh', timeoutMs: 5_000 })
}

describe('gh read-only tool', () => {
  test('normalizes owner/repo and github URLs', () => {
    assert.equal(normalizeGhRepository('openai/openai-node'), 'openai/openai-node')
    assert.equal(normalizeGhRepository('https://github.com/openai/openai-node.git'), 'openai/openai-node')
    assert.equal(normalizeGhRepository('https://example.com/openai/openai-node'), null)
    assert.equal(normalizeGhRepository('openai/openai-node/issues'), null)
  })

  test('schema exposes only four fixed read actions', () => {
    const tool = makeTool(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
    for (const action of ['view_repo', 'list_tree', 'read_file', 'search_code']) {
      const base = { action, repository: 'openai/openai-node' }
      const args = action === 'read_file'
        ? { ...base, path: 'src/index.ts' }
        : action === 'search_code'
          ? { ...base, query: 'responses.create' }
          : base
      assert.equal(tool.schema.safeParse(args).success, true, action)
    }
    assert.equal(tool.schema.safeParse({
      action: 'api',
      repository: 'openai/openai-node',
      command: 'repo delete openai/openai-node',
    }).success, false)
    assert.equal(tool.schema.safeParse({
      action: 'read_file',
      repository: 'openai/openai-node',
      path: '../secret',
    }).success, false)
  })

  test('central policy classifies every gh action as a parallel read', () => {
    for (const action of ['view_repo', 'list_tree', 'read_file', 'search_code']) {
      assert.deepEqual(classifyBotToolPolicy('gh', { action }), {
        sideEffect: false,
        concurrency: 'parallel',
      })
    }
  })

  test('view_repo uses fixed gh repo view arguments', async () => {
    const tool = makeTool(async (input) => {
      assert.equal(input.executable, '/opt/homebrew/bin/gh')
      assert.equal(input.timeoutMs, 5_000)
      assert.equal(input.maxOutputChars, 12_000)
      assert.deepEqual(input.args.slice(0, 4), ['repo', 'view', 'openai/openai-node', '--json'])
      return { exitCode: 0, stdout: '{"nameWithOwner":"openai/openai-node"}', stderr: '', timedOut: false }
    })

    const result = await tool.execute({
      action: 'view_repo',
      repository: 'https://github.com/openai/openai-node',
      maxChars: 12_000,
    }, ctx)
    const payload = JSON.parse(result.content as string)

    assert.equal(payload.ok, true)
    assert.equal(payload.repository, 'openai/openai-node')
    assert.equal(payload.format, 'json')
    assert.match(result.outcome?.noveltyKey ?? '', /^gh:/)
  })

  test('list_tree uses GET and a bounded line-oriented jq projection', async () => {
    const tool = makeTool(async (input) => {
      assert.deepEqual(input.args, [
        'api',
        '--method',
        'GET',
        '-f',
        'recursive=1',
        '--jq',
        '"apiTruncated=\\(.truncated)", (.tree[] | [.type, .path, (.size // 0)] | @tsv)',
        'repos/openai/openai-node/git/trees/main',
      ])
      return { exitCode: 0, stdout: 'apiTruncated=false\nblob\tsrc/index.ts\t1200\n', stderr: '', timedOut: false }
    })

    const result = await tool.execute({
      action: 'list_tree',
      repository: 'openai/openai-node',
      ref: 'main',
      recursive: true,
      maxChars: 12_000,
    }, ctx)
    const payload = JSON.parse(result.content as string)
    assert.equal(payload.ref, 'main')
    assert.match(payload.content, /src\/index\.ts/)
  })

  test('read_file requests raw content at a fixed ref', async () => {
    const tool = makeTool(async (input) => {
      assert.deepEqual(input.args, [
        'api',
        '--method',
        'GET',
        '-H',
        'Accept: application/vnd.github.raw+json',
        '-f',
        'ref=v1.0.0',
        'repos/openai/openai-node/contents/src/index.ts',
      ])
      return { exitCode: 0, stdout: 'export * from "./client.js"\n', stderr: '', timedOut: false }
    })

    const result = await tool.execute({
      action: 'read_file',
      repository: 'openai/openai-node',
      path: 'src/index.ts',
      ref: 'v1.0.0',
      maxChars: 12_000,
    }, ctx)
    assert.match(JSON.parse(result.content as string).content, /client\.js/)
  })

  test('search_code uses gh search with a repository scope and hard limit', async () => {
    const tool = makeTool(async (input) => {
      assert.deepEqual(input.args, [
        'search',
        'code',
        '--repo',
        'openai/openai-node',
        '--limit',
        '10',
        '--json',
        'path,repository,sha,textMatches,url',
        '--',
        'responses.create',
      ])
      return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false }
    })

    const result = await tool.execute({
      action: 'search_code',
      repository: 'openai/openai-node',
      query: 'responses.create',
      limit: 10,
      maxChars: 12_000,
    }, ctx)
    assert.equal(JSON.parse(result.content as string).ok, true)
  })

  test('returns structured timeout, unavailable and exit failures', async () => {
    const timeout = makeTool(async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }))
    const unavailable = makeTool(async () => ({ exitCode: null, stdout: '', stderr: 'spawn gh ENOENT', timedOut: false }))
    const failed = makeTool(async () => ({ exitCode: 1, stdout: '', stderr: 'HTTP 404', timedOut: false }))
    const args = { action: 'view_repo' as const, repository: 'openai/missing', maxChars: 12_000 }

    assert.equal(JSON.parse((await timeout.execute(args, ctx)).content as string).code, 'timeout')
    assert.equal(JSON.parse((await unavailable.execute(args, ctx)).content as string).code, 'gh_unavailable')
    assert.equal(JSON.parse((await failed.execute(args, ctx)).content as string).code, 'exit_1')
  })
})
