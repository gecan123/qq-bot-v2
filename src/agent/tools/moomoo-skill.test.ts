import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BotEvent } from '../event.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { ToolContext } from '../tool.js'
import {
  createMoomooSkillTool,
  isAllowedMoomooSkillCommand,
  parseMoomooSkillCommand,
  runMoomooSkillCommand,
  type MoomooSkillRunner,
} from './moomoo-skill.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

function makeTool(runner: MoomooSkillRunner) {
  return createMoomooSkillTool({
    runner,
    pythonBin: '/venv/bin/python3',
    skillDir: '/opt/moomoo/skills/moomooapi',
    opendPort: 11_111,
    timeoutMs: 5_000,
  })
}

describe('moomoo_skill tool', () => {
  test('only accepts curated query scripts and explicitly simulated trade scripts', () => {
    assert.deepEqual(parseMoomooSkillCommand('quote/get_snapshot US.AAPL HK.00700'), {
      script: 'quote/get_snapshot',
      args: ['US.AAPL', 'HK.00700'],
    })
    assert.equal(isAllowedMoomooSkillCommand('trade/get_portfolio --trd-env REAL'), true)
    assert.equal(isAllowedMoomooSkillCommand(
      'trade/place_order --code US.AAPL --side BUY --quantity 1 --price 100 --trd-env SIMULATE',
    ), true)
    assert.equal(isAllowedMoomooSkillCommand(
      'trade/modify_order --order-id 123 --price 101 --trd-env=SIMULATE',
    ), true)
    assert.equal(isAllowedMoomooSkillCommand(
      'trade/cancel_order --order-id 123 --trd-env SIMULATE',
    ), true)

    for (const command of [
      'python3 -c "print(1)"',
      'quote/get_snapshot.py US.AAPL',
      '../../tmp/evil.py',
      'trade/place_order --code US.AAPL --side BUY --quantity 1 --price 100',
      'trade/place_order --code US.AAPL --side BUY --quantity 1 --price 100 --trd-env REAL --confirmed',
      'trade/place_order --code US.AAPL --side BUY --quantity 1 --price 100 --trd-env SIMULATE --confirmed=true',
      'trade/modify_order --order-id 123 --price 101 --trd-env REAL',
      'trade/cancel_order --order-id 123 --trd-env REAL',
      'trade/place_crypto_order --code CC.BTCUSD --side BUY --quantity 1',
      'trade/place_combo_order --trd-env SIMULATE',
      'trade/get_accounts --confirmed',
      'quote/get_snapshot US.AAPL; rm -rf /',
    ]) {
      assert.equal(isAllowedMoomooSkillCommand(command), false, command)
    }
  })

  test('maps command to a fixed official script path and adds JSON output', async () => {
    const tool = makeTool(async (script, args, options) => {
      assert.equal(script, 'scripts/quote/get_snapshot.py')
      assert.deepEqual(args, ['US.AAPL', 'HK.00700', '--json'])
      assert.equal(options.pythonBin, '/venv/bin/python3')
      assert.equal(options.skillDir, '/opt/moomoo/skills/moomooapi')
      assert.equal(options.opendPort, 11_111)
      return {
        exitCode: 0,
        stdout: '{"data":[{"code":"US.AAPL","last_price":212.4}]}',
        stderr: '',
        timedOut: false,
      }
    })

    const result = await tool.execute({ command: 'quote/get_snapshot US.AAPL HK.00700' }, makeCtx())
    assert.deepEqual(JSON.parse(result.content as string), {
      ok: true,
      exitCode: 0,
      format: 'text',
      content: '{"data":[{"code":"US.AAPL","last_price":212.4}]}',
      stderr: '',
      truncated: false,
    })
    assert.deepEqual(result.outcome, { ok: true })
  })

  test('preserves explicit JSON flag and returns structured failures', async () => {
    const tool = makeTool(async (_script, args) => {
      assert.deepEqual(args, ['--json'])
      return { exitCode: 1, stdout: '', stderr: 'OpenD unavailable', timedOut: false }
    })

    const result = await tool.execute({ command: 'check_env --json' }, makeCtx())
    assert.deepEqual(JSON.parse(result.content as string), {
      ok: false,
      exitCode: 1,
      format: 'text',
      content: '',
      stderr: 'OpenD unavailable',
      truncated: false,
    })
    assert.deepEqual(result.outcome, { ok: false, code: 'exit_1' })
  })

  test('routes an explicitly simulated order to the fixed official script', async () => {
    const tool = makeTool(async (script, args) => {
      assert.equal(script, 'scripts/trade/place_order.py')
      assert.deepEqual(args, [
        '--code', 'US.AAPL',
        '--side', 'BUY',
        '--quantity', '1',
        '--price', '100',
        '--trd-env', 'SIMULATE',
        '--json',
      ])
      return { exitCode: 0, stdout: '{"status":"submitted","trd_env":"SIMULATE"}', stderr: '', timedOut: false }
    })

    const result = await tool.execute({
      command: 'trade/place_order --code US.AAPL --side BUY --quantity 1 --price 100 --trd-env SIMULATE',
    }, makeCtx())
    assert.equal(JSON.parse(result.content as string).ok, true)
  })

  test('reports timeout without breaking the JSON envelope', async () => {
    const tool = makeTool(async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }))
    const result = await tool.execute({ command: 'check_env' }, makeCtx())
    const parsed = JSON.parse(result.content as string)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.code, 'timeout')
    assert.equal(parsed.error, 'Moomoo command timeout')
    assert.deepEqual(result.outcome, { ok: false, code: 'timeout' })
  })

  test('requires an absolute configured Skill directory', () => {
    assert.throws(
      () => createMoomooSkillTool({ skillDir: 'relative/moomooapi' }),
      /must be an absolute path/,
    )
  })

  test('real runner executes only the resolved script with loopback OpenD env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moomoo-skill-'))
    try {
      await mkdir(join(root, 'scripts', 'quote'), { recursive: true })
      await writeFile(join(root, 'scripts', 'quote', 'get_snapshot.py'), [
        'import json, os, sys',
        'print(json.dumps({"args": sys.argv[1:], "host": os.getenv("MOOMOO_OPEND_HOST"), "port": os.getenv("MOOMOO_OPEND_PORT"), "legacy_host": os.getenv("FUTU_OPEND_HOST"), "legacy_port": os.getenv("FUTU_OPEND_PORT")}))',
      ].join('\n'))

      const result = await runMoomooSkillCommand(
        'scripts/quote/get_snapshot.py',
        ['US.AAPL', '--json'],
        {
          pythonBin: 'python3',
          skillDir: root,
          opendPort: 12_345,
          timeoutMs: 5_000,
          captureCapBytes: 64 * 1024,
        },
      )

      assert.equal(result.exitCode, 0)
      assert.deepEqual(JSON.parse(result.stdout), {
        args: ['US.AAPL', '--json'],
        host: '127.0.0.1',
        port: '12345',
        legacy_host: '127.0.0.1',
        legacy_port: '12345',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
