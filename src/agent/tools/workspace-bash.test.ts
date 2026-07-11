import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../tool.js'
import type { BotEvent } from '../event.js'
import { InMemoryEventQueue } from '../event-queue.js'
import {
  createWorkspaceBashTool,
  parseWorkspaceBashCommand,
  runWorkspaceBashCommand,
  type WorkspaceBashRunner,
} from './workspace-bash.js'
import type { Tool } from '../tool.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

function unwrapCommandJson(content: unknown): Record<string, unknown> {
  assert.equal(typeof content, 'string')
  const envelope = JSON.parse(content as string) as { format: string; content: string }
  assert.equal(envelope.format, 'json')
  return JSON.parse(envelope.content) as Record<string, unknown>
}

describe('workspace_bash command parser', () => {
  test('accepts simple workspace reads and rejects raw writes', () => {
    assert.deepEqual(parseWorkspaceBashCommand('pwd'), {
      ok: true,
      kind: 'workspace',
      cwd: 'workspace',
      command: 'pwd',
      args: [],
    })

    assert.equal(parseWorkspaceBashCommand("printf 'hello\\n' > notes/today.md").ok, false)
    assert.equal(parseWorkspaceBashCommand('touch notes/today.md').ok, false)
    assert.equal(parseWorkspaceBashCommand('mkdir notes').ok, false)
  })

  test('rejects the old pnpm db:query alias for database access', () => {
    const parsed = parseWorkspaceBashCommand('pnpm db:query \'{"sql":"select 1","params":{}}\'')

    assert.equal(parsed.ok, false)
  })

  test('accepts controlled db, style, openbb, and ai_tone subcommands in workspace mode', () => {
    assert.deepEqual(parseWorkspaceBashCommand('db schema'), {
      ok: true,
      kind: 'db_tool',
      cwd: 'workspace',
      action: 'schema',
    })

    assert.deepEqual(parseWorkspaceBashCommand('db query \'{"sql":"select 1","params":{"group_id":123}}\''), {
      ok: true,
      kind: 'db_tool',
      cwd: 'workspace',
      action: 'query',
      sql: 'select 1',
      params: { group_id: 123 },
    })

    assert.deepEqual(parseWorkspaceBashCommand('db query {"sql":"SELECT * FROM media ORDER BY created_at DESC LIMIT 5"}'), {
      ok: true,
      kind: 'db_tool',
      cwd: 'workspace',
      action: 'query',
      sql: 'SELECT * FROM media ORDER BY created_at DESC LIMIT 5',
    })

    assert.deepEqual(parseWorkspaceBashCommand('style global anti_patterns'), {
      ok: true,
      kind: 'style',
      cwd: 'workspace',
      scope: 'global',
      section: 'anti_patterns',
    })

    assert.deepEqual(parseWorkspaceBashCommand('style global constraints'), {
      ok: true,
      kind: 'style',
      cwd: 'workspace',
      scope: 'global',
      section: 'constraints',
    })

    assert.deepEqual(parseWorkspaceBashCommand('style group 222'), {
      ok: true,
      kind: 'style',
      cwd: 'workspace',
      scope: 'group',
      groupId: 222,
    })

    assert.deepEqual(parseWorkspaceBashCommand('openbb /equity/price/historical --symbol AAPL --provider yfinance'), {
      ok: true,
      kind: 'openbb',
      cwd: 'workspace',
      command: '/equity/price/historical --symbol AAPL --provider yfinance',
    })

    assert.deepEqual(parseWorkspaceBashCommand('moomoo quote/get_snapshot US.AAPL HK.00700'), {
      ok: true,
      kind: 'moomoo',
      cwd: 'workspace',
      command: 'quote/get_snapshot US.AAPL HK.00700',
    })

    assert.deepEqual(parseWorkspaceBashCommand(
      'moomoo trade/place_order --code US.AAPL --side BUY --quantity 1 --price 100 --trd-env SIMULATE',
    ), {
      ok: true,
      kind: 'moomoo',
      cwd: 'workspace',
      command: 'trade/place_order --code US.AAPL --side BUY --quantity 1 --price 100 --trd-env SIMULATE',
    })

    assert.deepEqual(parseWorkspaceBashCommand('ai_tone \'{"text":"这玩意儿真就那样吧","threshold":0.7}\''), {
      ok: true,
      kind: 'ai_tone',
      cwd: 'workspace',
      text: '这玩意儿真就那样吧',
      threshold: 0.7,
    })
  })

  test('accepts controlled fetch subcommands in workspace mode', () => {
    assert.deepEqual(parseWorkspaceBashCommand('fetch url "https://example.com/post" "核心观点"'), {
      ok: true,
      kind: 'fetch',
      cwd: 'workspace',
      action: 'url',
      url: 'https://example.com/post',
      hint: '核心观点',
    })

    assert.deepEqual(parseWorkspaceBashCommand('fetch image https://example.com/cat.png'), {
      ok: true,
      kind: 'fetch',
      cwd: 'workspace',
      action: 'image_url',
      url: 'https://example.com/cat.png',
    })

    assert.deepEqual(parseWorkspaceBashCommand('fetch avatar 123 100'), {
      ok: true,
      kind: 'fetch',
      cwd: 'workspace',
      action: 'qq_avatar',
      qq: 123,
      size: '100',
    })

    assert.deepEqual(parseWorkspaceBashCommand('fetch reddit list technology top 5'), {
      ok: true,
      kind: 'fetch',
      cwd: 'workspace',
      action: 'reddit_list',
      subreddit: 'technology',
      sort: 'top',
      limit: 5,
    })

    assert.deepEqual(parseWorkspaceBashCommand('fetch reddit post "https://www.reddit.com/r/technology/comments/abc123/title/"'), {
      ok: true,
      kind: 'fetch',
      cwd: 'workspace',
      action: 'reddit_post',
      url: 'https://www.reddit.com/r/technology/comments/abc123/title/',
    })
  })

  test('rejects the removed workspace_bash journal alias', () => {
    assert.deepEqual(parseWorkspaceBashCommand('journal write diary "今天很充实"'), {
      ok: false,
      error: 'command is not allowed: journal',
    })
  })

  test('accepts help subcommands in workspace mode', () => {
    assert.deepEqual(parseWorkspaceBashCommand('help'), {
      ok: true,
      kind: 'help',
      cwd: 'workspace',
    })

    assert.deepEqual(parseWorkspaceBashCommand('help workspace'), {
      ok: true,
      kind: 'help',
      cwd: 'workspace',
      topic: 'workspace',
    })
  })

  test('accepts read-only repo code inspection commands', () => {
    assert.deepEqual(parseWorkspaceBashCommand('rg "buildBotTools" src/agent/tools/index.ts', 'repo'), {
      ok: true,
      kind: 'workspace',
      cwd: 'repo',
      command: 'rg',
      args: ['buildBotTools', 'src/agent/tools/index.ts'],
    })

    assert.deepEqual(parseWorkspaceBashCommand('rg --files src/agent/tools', 'repo'), {
      ok: true,
      kind: 'workspace',
      cwd: 'repo',
      command: 'rg',
      args: ['--files', 'src/agent/tools'],
    })
  })

  test('rejects shell escapes, disallowed commands, and path escapes', () => {
    const rejected = [
      'cat .env',
      'cat .env.local',
      'cat ../.env',
      'cat /etc/passwd',
      'curl https://example.com',
      'psql "$DATABASE_URL"',
      'node -e "console.log(process.env)"',
      'ls && cat .env',
      'printf hi > ../leak.txt',
      'pnpm test',
      'journal write note hi',
      'help secrets',
      'journal search',
      'db drop table messages',
      'db query not-json',
      'style global secrets',
      'style group not-a-number',
      'fetch reddit list notallowed hot 5',
      'fetch reddit list technology best 5',
      'fetch reddit list technology hot 50',
      'fetch reddit post https://example.com/not-reddit',
      'fetch avatar nobody',
      'openbb curl https://example.com',
      'moomoo quote/get_snapshot.py US.AAPL',
      'moomoo trade/place_order --code US.AAPL --quantity 1',
      'moomoo ../../escape',
      'ai_tone not-json',
      'ai_tone \'{"text":"","threshold":0.6}\'',
      'ai_tone \'{"text":"hi","threshold":2}\'',
      'find .',
      "sed -n '1,5p' notes.md",
      "printf 'bad' > journal/diary/2026-06.md",
      "printf 'bad' > life/journal/2026-07-11.md",
      'touch journal/diary/2026-06.md',
      'touch life/agenda.md',
      'mkdir journal/custom',
    ]

    for (const command of rejected) {
      const parsed = parseWorkspaceBashCommand(command)
      assert.equal(parsed.ok, false, `${command} should be rejected`)
    }
  })

  test('allows reading managed files through workspace_bash but not direct writes', () => {
    assert.deepEqual(parseWorkspaceBashCommand('cat journal/diary/2026-06.md'), {
      ok: true,
      kind: 'workspace',
      cwd: 'workspace',
      command: 'cat',
      args: ['journal/diary/2026-06.md'],
    })
    assert.deepEqual(parseWorkspaceBashCommand('cat life/journal/2026-07-11.md'), {
      ok: true,
      kind: 'workspace',
      cwd: 'workspace',
      command: 'cat',
      args: ['life/journal/2026-07-11.md'],
    })

    for (const command of [
      "printf 'bad' > journal/diary/2026-06.md",
      "printf 'bad' >> journal/diary/2026-06.md",
      "printf 'bad' > life/journal/2026-07-11.md",
      'touch journal/diary/2026-06.md',
      'touch life/agenda.md',
      'mkdir journal/custom',
    ]) {
      const parsed = parseWorkspaceBashCommand(command)
      assert.equal(parsed.ok, false, `${command} should be rejected`)
    }
  })

  test('rejects repo writes and sensitive repo paths', () => {
    const rejected = [
      "printf 'note' > notes.md",
      'mkdir tmp',
      'touch src/new.ts',
      'cat .env',
      'cat .env.production',
      'cat logs/tool-calls.ndjson',
      'cat prompts/groups.yaml',
      'cat data/agent-workspace/journal.md',
      'cat node_modules/.bin/tsx',
      'cat .git/config',
      'cat ../qq-bot-v2/package.json',
      'journal list',
      'help',
      'db schema',
      'style global',
      'fetch url https://example.com',
      'openbb /equity/price/historical --symbol AAPL',
      'ai_tone \'{"text":"hi"}\'',
    ]

    for (const command of rejected) {
      const parsed = parseWorkspaceBashCommand(command, 'repo')
      assert.equal(parsed.ok, false, `${command} should be rejected in repo mode`)
    }
  })

  test('rejects shell-capable or write-capable command surfaces in repo mode', () => {
    const rejected = [
      'find .',
      "find . -exec sh -c 'cat .env' +",
      "rg --pre 'sh -c cat .env' x src",
      'rg -uuu BOT_OWNER .',
      "sed -i '' s/foo/bar/ src/agent/tools/index.ts",
    ]

    for (const command of rejected) {
      const parsed = parseWorkspaceBashCommand(command, 'repo')
      assert.equal(parsed.ok, false, `${command} should be rejected in repo mode`)
    }
  })
})

describe('workspace_bash tool', () => {
  test('runs accepted commands in the configured workspace with minimal env', async () => {
    let captured: Parameters<WorkspaceBashRunner>[0] | null = null
    const runner: WorkspaceBashRunner = async (input) => {
      captured = input
      return { exitCode: 0, stdout: 'notes\n', stderr: '', timedOut: false }
    }
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      runner,
    })

    const result = await tool.execute({ command: 'ls notes' }, makeCtx())

    assert.deepEqual(JSON.parse(result.content as string), {
      ok: true,
      exitCode: 0,
      format: 'text',
      content: 'notes\n',
      stderr: '',
      truncated: false,
    })
    assert.deepEqual(result.outcome, { ok: true })
    assert.deepEqual(captured, {
      executable: 'ls',
      args: ['notes'],
      cwd: '/tmp/agent-workspace',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdin: undefined,
      timeoutMs: 5000,
      maxOutputChars: 4000,
    })
  })

  test('runs repo inspection commands in repo cwd', async () => {
    let captured: Parameters<WorkspaceBashRunner>[0] | null = null
    const runner: WorkspaceBashRunner = async (input) => {
      captured = input
      return { exitCode: 0, stdout: 'src/agent/tools/index.ts:37:export function buildBotTools', stderr: '', timedOut: false }
    }
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      runner,
    })

    const result = await tool.execute({ cwd: 'repo', command: 'rg "buildBotTools" src/agent/tools/index.ts' }, makeCtx())

    const envelope = JSON.parse(result.content as string)
    assert.match(envelope.content, /buildBotTools/)
    assert.equal(envelope.format, 'text')
    assert.deepEqual(captured, {
      executable: 'rg',
      args: ['buildBotTools', 'src/agent/tools/index.ts'],
      cwd: '/repo',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdin: undefined,
      timeoutMs: 5000,
      maxOutputChars: 4000,
    })
  })

  test('returns structured error without executing rejected commands', async () => {
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      runner: async () => {
        throw new Error('runner should not be called')
      },
    })

    const result = await tool.execute({ command: 'cat .env' }, makeCtx())
    const parsed = JSON.parse(result.content as string)

    assert.equal(parsed.ok, false)
    assert.equal(parsed.exitCode, null)
    assert.equal(parsed.format, 'text')
    assert.equal(parsed.content, '')
    assert.match(parsed.stderr, /not allowed/i)
    assert.equal(parsed.truncated, false)
    assert.match(parsed.error, /not allowed/i)
    assert.equal(parsed.help, 'help workspace')
    assert.equal(parsed.try, 'help')
    assert.deepEqual(result.outcome, { ok: false, code: 'command_not_allowed' })
  })

  test('wraps non-zero exits and timeout as explicit failed outcomes', async () => {
    const failedTool = createWorkspaceBashTool({
      runner: async () => ({ exitCode: 2, stdout: 'partial', stderr: 'bad args', timedOut: false }),
    })
    const failed = await failedTool.execute({ command: 'ls notes' }, makeCtx())
    assert.deepEqual(JSON.parse(failed.content as string), {
      ok: false,
      exitCode: 2,
      format: 'text',
      content: 'partial',
      stderr: 'bad args',
      truncated: false,
    })
    assert.deepEqual(failed.outcome, { ok: false, code: 'exit_2' })

    const timeoutTool = createWorkspaceBashTool({
      runner: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
    })
    const timedOut = await timeoutTool.execute({ command: 'ls notes' }, makeCtx())
    assert.equal(JSON.parse(timedOut.content as string).code, 'timeout')
    assert.deepEqual(timedOut.outcome, { ok: false, code: 'timeout' })
  })

  test('returns one-hop guidance for rejected subcommands', async () => {
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      runner: async () => {
        throw new Error('runner should not be called')
      },
    })

    const result = await tool.execute({ command: 'fetch reddit list notallowed hot 5' }, makeCtx())
    const parsed = JSON.parse(result.content as string) as {
      ok: boolean
      error: string
      help?: string
      try?: string
    }

    assert.equal(parsed.ok, false)
    assert.match(parsed.error, /subreddit must be one of/)
    assert.equal(parsed.help, 'help fetch')
    assert.equal(parsed.try, 'fetch reddit list technology hot 5')
  })

  test('renders help without shelling out', async () => {
    let runnerCalled = false
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      runner: async () => {
        runnerCalled = true
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    const overview = unwrapCommandJson((await tool.execute({ command: 'help' }, makeCtx())).content) as unknown as {
      ok: boolean
      topics: string[]
      examples: string[]
    }
    assert.equal(overview.ok, true)
    assert.equal(overview.topics.includes('journal'), false)
    assert.ok(overview.examples.includes('fetch reddit list technology hot 5'))
    assert.equal(runnerCalled, false)
  })

  test('description exposes common routes without requiring help first', () => {
    const tool = createWorkspaceBashTool()

    assert.match(tool.description, /fetch url <url> \[hint\]/)
    assert.match(tool.description, /fetch reddit list technology hot 5/)
    assert.match(tool.description, /cwd=repo/)
    assert.match(tool.description, /db schema/)
    assert.doesNotMatch(tool.description, /journal write\|list\|search\|read/)
  })

  test('runs db schema/query through the internal db tool without shelling out', async () => {
    let runnerCalled = false
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      groupIdWhitelist: [123],
      executeDbRead: async (params) => ({
        ok: true,
        sql: params.sql,
        params: params.params,
        rows: [{ answer: 1 }],
      }),
      runner: async () => {
        runnerCalled = true
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    const schema = await tool.execute({ command: 'db schema' }, makeCtx())
    assert.match(schema.content as string, /messages/)

    const queried = JSON.parse((await tool.execute({
      command: 'db query \'{"sql":"select 1","params":{"group_id":123}}\'',
    }, makeCtx())).content as string) as { ok: boolean; rows: { answer: number }[] }
    assert.equal(queried.ok, true)
    assert.equal(queried.rows[0]!.answer, 1)
    assert.equal(runnerCalled, false)
  })

  test('runs style commands through the internal style reader without shelling out', async () => {
    let runnerCalled = false
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      groupIds: [222],
      metadata: { groupNames: new Map([[222, '测试群']]) },
      groupCustomizations: [{ id: 222, frequencyHint: 'chatty', body: '这个群喜欢短句接梗。' }],
      runner: async () => {
        runnerCalled = true
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    const global = await tool.execute({ command: 'style global' }, makeCtx())
    assert.match(global.content as string, /Luna 按需风格指南/)
    assert.match(global.content as string, /constraints/)

    const constraints = await tool.execute({ command: 'style global constraints' }, makeCtx())
    assert.match(constraints.content as string, /聊天约束/)

    const group = JSON.parse((await tool.execute({ command: 'style group 222' }, makeCtx())).content as string) as {
      ok: boolean
      groupName: string
      body: string
    }
    assert.equal(group.ok, true)
    assert.equal(group.groupName, '测试群')
    assert.equal(group.body, '这个群喜欢短句接梗。')
    assert.equal(runnerCalled, false)
  })

  test('runs openbb through the configured OpenBB delegate without shelling out', async () => {
    const calls: unknown[] = []
    let runnerCalled = false
    const openbbTool: Tool = {
      name: 'openbb_cli',
      description: 'test openbb',
      schema: {} as never,
      async execute(args) {
        calls.push(args)
        return { content: '[{"symbol":"AAPL"}]' }
      },
    }
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      openbbTool,
      runner: async () => {
        runnerCalled = true
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    const result = await tool.execute({
      command: 'openbb /equity/price/historical --symbol AAPL --provider yfinance',
    }, makeCtx())

    assert.equal(result.content, '[{"symbol":"AAPL"}]')
    assert.deepEqual(calls, [{ command: '/equity/price/historical --symbol AAPL --provider yfinance' }])
    assert.equal(runnerCalled, false)
  })

  test('runs moomoo through the configured read-only delegate without shelling out', async () => {
    const calls: unknown[] = []
    let runnerCalled = false
    const moomooTool: Tool = {
      name: 'moomoo_skill',
      description: 'test moomoo',
      schema: {} as never,
      async execute(args) {
        calls.push(args)
        return { content: '{"ok":true}' }
      },
    }
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      moomooTool,
      runner: async () => {
        runnerCalled = true
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    const result = await tool.execute({
      command: 'moomoo quote/get_snapshot US.AAPL HK.00700',
    }, makeCtx())

    assert.equal(result.content, '{"ok":true}')
    assert.deepEqual(calls, [{ command: 'quote/get_snapshot US.AAPL HK.00700' }])
    assert.equal(runnerCalled, false)
  })

  test('runs ai_tone through the internal classifier without shelling out', async () => {
    let runnerCalled = false
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      aiTonePredictor: async (text, threshold) => ({
        prob: 0.42,
        isAI: false,
        label: '人味',
        threshold: threshold ?? 0.6,
        textLength: text.length,
      }),
      runner: async () => {
        runnerCalled = true
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    const result = JSON.parse((await tool.execute({
      command: 'ai_tone \'{"text":"这玩意儿真就那样吧","threshold":0.7}\'',
    }, makeCtx())).content as string) as {
      ok: boolean
      prob: number
      isAI: boolean
      label: string
      threshold: number
      textLength: number
    }

    assert.deepEqual(result, {
      ok: true,
      prob: 0.42,
      isAI: false,
      label: '人味',
      threshold: 0.7,
      textLength: 9,
    })
    assert.equal(runnerCalled, false)
  })

  test('runs fetch through the configured fetch delegate without shelling out', async () => {
    const calls: unknown[] = []
    let runnerCalled = false
    const fetchTool: Tool = {
      name: 'fetch_content',
      description: 'test fetch',
      schema: {} as never,
      async execute(args) {
        calls.push(args)
        return { content: JSON.stringify({ ok: true, args }) }
      },
    }
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      fetchTool,
      runner: async () => {
        runnerCalled = true
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    await tool.execute({ command: 'fetch url "https://example.com/post" "核心观点"' }, makeCtx())
    await tool.execute({ command: 'fetch image https://example.com/cat.png' }, makeCtx())
    await tool.execute({ command: 'fetch avatar 123 100' }, makeCtx())
    await tool.execute({ command: 'fetch reddit list technology top 5' }, makeCtx())
    const result = await tool.execute({
      command: 'fetch reddit post "https://www.reddit.com/r/technology/comments/abc123/title/"',
    }, makeCtx())

    assert.match(result.content as string, /reddit_post/)
    assert.deepEqual(calls, [
      { action: 'url', url: 'https://example.com/post', hint: '核心观点' },
      { action: 'image_url', url: 'https://example.com/cat.png' },
      { action: 'qq_avatar', qq: 123, size: '100' },
      { action: 'reddit_list', subreddit: 'technology', sort: 'top', limit: 5 },
      { action: 'reddit_post', url: 'https://www.reddit.com/r/technology/comments/abc123/title/' },
    ])
    assert.equal(runnerCalled, false)
  })
})

describe('runWorkspaceBashCommand', () => {
  test('does not expose a parsed raw-write command', () => {
    assert.equal(parseWorkspaceBashCommand("printf 'hello' > notes/today.md").ok, false)
  })
})
