import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'
import {
  CryptoPaperError,
  createCryptoPaperTool,
  type CryptoPaperAccountState,
  type CryptoPaperOrderState,
  type CryptoPaperStore,
} from './crypto-paper.js'

function ctx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }
}

function account(overrides: Partial<CryptoPaperAccountState> = {}): CryptoPaperAccountState {
  return {
    id: 1,
    currency: 'USD',
    initialCash: '100000',
    cash: '100000',
    realizedPnl: '0',
    feeRateBps: 10,
    generation: 1,
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  }
}

function order(overrides: Partial<CryptoPaperOrderState> = {}): CryptoPaperOrderState {
  return {
    id: '1',
    clientOrderId: 'btc-buy-001',
    generation: 1,
    symbol: 'CC.BTCUSD',
    side: 'BUY',
    quantity: '0.1',
    price: '101',
    notional: '10.1',
    fee: '0.0101',
    realizedPnl: '0',
    cashAfter: '99989.8899',
    positionQuantityAfter: '0.1',
    status: 'FILLED',
    quoteTime: '2026-07-11T00:00:00.000Z',
    note: null,
    createdAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  }
}

function fakeStore(overrides: Partial<CryptoPaperStore> = {}): CryptoPaperStore {
  return {
    async getAccount() { return account() },
    async getPositions() { return [] },
    async getOrderByClientOrderId() { return null },
    async listOrders() { return [] },
    async executeMarketOrder(input) {
      return { order: order({
        clientOrderId: input.clientOrderId,
        side: input.side,
        symbol: input.symbol,
        quantity: input.quantity,
        price: input.price,
      }), duplicate: false }
    },
    async reset() { return account({ generation: 2 }) },
    ...overrides,
  }
}

describe('crypto_paper tool', () => {
  test('returns a clearly local account and never claims live trading', async () => {
    const tool = createCryptoPaperTool({
      store: fakeStore(),
      quoteProvider: async () => { throw new Error('not called') },
    })
    const result = JSON.parse((await tool.execute({ action: 'account' }, ctx())).content as string)
    assert.equal(result.ok, true)
    assert.equal(result.liveTrading, false)
    assert.equal(result.account.cash, '100000')
  })

  test('buys at ask and sells at bid with a stable client order id', async () => {
    const calls: unknown[] = []
    const store = fakeStore({
      async executeMarketOrder(input) {
        calls.push(input)
        return { order: order({
          clientOrderId: input.clientOrderId,
          side: input.side,
          price: input.price,
        }), duplicate: false }
      },
    })
    const tool = createCryptoPaperTool({
      store,
      quoteProvider: async (symbol) => ({
        symbol,
        last: 100,
        bid: 99,
        ask: 101,
        quotedAt: new Date('2026-07-11T00:00:00.000Z'),
      }),
    })

    const bought = JSON.parse((await tool.execute({
      action: 'buy', symbol: 'cc.btcusd', quantity: 0.1, clientOrderId: 'btc-buy-001',
    }, ctx())).content as string)
    const sold = JSON.parse((await tool.execute({
      action: 'sell', symbol: 'CC.BTCUSD', quantity: 0.05, clientOrderId: 'btc-sell-001',
    }, ctx())).content as string)

    assert.equal(bought.pricing, 'moomoo_ask')
    assert.equal(bought.order.price, '101')
    assert.equal(sold.pricing, 'moomoo_bid')
    assert.equal(sold.order.price, '99')
    assert.deepEqual(calls, [
      {
        clientOrderId: 'btc-buy-001', side: 'BUY', symbol: 'CC.BTCUSD', quantity: '0.1',
        price: '101', quoteTime: new Date('2026-07-11T00:00:00.000Z'), note: undefined,
      },
      {
        clientOrderId: 'btc-sell-001', side: 'SELL', symbol: 'CC.BTCUSD', quantity: '0.05',
        price: '99', quoteTime: new Date('2026-07-11T00:00:00.000Z'), note: undefined,
      },
    ])
  })

  test('returns an existing idempotent order without fetching another quote', async () => {
    let quoteCalls = 0
    const existing = order()
    const tool = createCryptoPaperTool({
      store: fakeStore({ async getOrderByClientOrderId() { return existing } }),
      quoteProvider: async () => {
        quoteCalls += 1
        throw new Error('must not run')
      },
    })
    const result = JSON.parse((await tool.execute({
      action: 'buy', symbol: 'CC.BTCUSD', quantity: 0.1, clientOrderId: 'btc-buy-001',
    }, ctx())).content as string)
    assert.equal(result.duplicate, true)
    assert.equal(result.order.id, '1')
    assert.equal(quoteCalls, 0)
  })

  test('calculates portfolio using bid-side liquidation and estimated exit fee', async () => {
    const tool = createCryptoPaperTool({
      store: fakeStore({
        async getAccount() { return account({ cash: '90000' }) },
        async getPositions() {
          return [{ symbol: 'CC.BTCUSD', quantity: '1', averageCost: '10000' }]
        },
      }),
      quoteProvider: async (symbol) => ({
        symbol, last: 11_100, bid: 11_000, ask: 11_200,
        quotedAt: new Date('2026-07-11T00:00:00.000Z'),
      }),
    })
    const result = JSON.parse((await tool.execute({ action: 'portfolio' }, ctx())).content as string)
    assert.equal(result.equity, '100989')
    assert.equal(result.unrealizedPnl, '989')
    assert.equal(result.totalPnl, '989')
  })

  test('returns business failures as stable JSON', async () => {
    const tool = createCryptoPaperTool({
      store: fakeStore({
        async executeMarketOrder() { throw new CryptoPaperError('insufficient_cash', '虚拟现金不足') },
      }),
      quoteProvider: async (symbol) => ({ symbol, last: 100, bid: 99, ask: 101, quotedAt: new Date() }),
    })
    const response = await tool.execute({
      action: 'buy', symbol: 'CC.BTCUSD', quantity: 1, clientOrderId: 'btc-buy-002',
    }, ctx())
    const result = JSON.parse(response.content as string)
    assert.deepEqual(result, {
      ok: false,
      liveTrading: false,
      code: 'insufficient_cash',
      error: '虚拟现金不足',
    })
    assert.deepEqual(response.outcome, {
      ok: false,
      code: 'insufficient_cash',
      error: '虚拟现金不足',
    })
  })
})
