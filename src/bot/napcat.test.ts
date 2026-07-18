import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'
import { disableNapcatReconnection } from './napcat.js'

describe('NapCat shutdown wiring', () => {
  test('disables library auto-reconnection synchronously from socket.close', () => {
    const context = { reconnection: { enable: true } }

    disableNapcatReconnection(context)

    assert.equal(context.reconnection.enable, false)
  })

  test('uses the shutdown-specific disconnect path in both runtime states', async () => {
    const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8')

    assert.match(source, /disconnectIngress: disconnectNapcatForShutdown/)
    assert.match(source, /function shutdownBeforeRuntimeReady[\s\S]*disconnectNapcatForShutdown\(\)/)
  })
})
