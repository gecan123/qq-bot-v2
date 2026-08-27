import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'
import {
  AUTONOMOUS_CRYPTO_PAPER_MAX_ORDER_EQUITY_RATIO,
  AUTONOMOUS_CRYPTO_PAPER_MAX_SYMBOL_EQUITY_RATIO,
  AUTONOMOUS_CRYPTO_PAPER_SYMBOLS,
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
  test('explicitly identifies paper trading as the simulation tool', () => {
    const tool = createCryptoPaperTool({
      store: fakeStore(),
      quoteProvider: async () => { throw new Error('not called') },
    })
    assert.match(tool.description, /就是 Crypto 模拟盘（paper trading）工具/)
    assert.match(tool.description, /不需要再等待或寻找另一个“模拟盘工具”/)
    assert.match(tool.description, /decisionSource=self.*BTC\/ETH\/SOL.*权益 5%.*权益 20%/s)
  })

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
      action: 'buy', decisionSource: 'owner', symbol: 'cc.btcusd', quantity: 0.1,
      clientOrderId: 'btc-buy-001', note: 'owner 明确要求测试买入',
    }, ctx())).content as string)
    const sold = JSON.parse((await tool.execute({
      action: 'sell', decisionSource: 'owner', symbol: 'CC.BTCUSD', quantity: 0.05,
      clientOrderId: 'btc-sell-001', note: 'owner 明确要求测试卖出',
    }, ctx())).content as string)

    assert.equal(bought.pricing, 'moomoo_ask')
    assert.equal(bought.order.price, '101')
    assert.equal(bought.decisionSource, 'owner')
    assert.equal(sold.pricing, 'moomoo_bid')
    assert.equal(sold.order.price, '99')
    assert.deepEqual(calls, [
      {
        clientOrderId: 'btc-buy-001', side: 'BUY', symbol: 'CC.BTCUSD', quantity: '0.1',
        price: '101', quoteTime: new Date('2026-07-11T00:00:00.000Z'), note: 'owner 明确要求测试买入',
      },
      {
        clientOrderId: 'btc-sell-001', side: 'SELL', symbol: 'CC.BTCUSD', quantity: '0.05',
        price: '99', quoteTime: new Date('2026-07-11T00:00:00.000Z'), note: 'owner 明确要求测试卖出',
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
      action: 'buy', decisionSource: 'owner', symbol: 'CC.BTCUSD', quantity: 0.1,
      clientOrderId: 'btc-buy-001', note: '重试同一笔 owner 订单',
    }, ctx())).content as string)
    assert.equal(result.duplicate, true)
    assert.equal(result.order.id, '1')
    assert.equal(quoteCalls, 0)
  })

  test('enforces the standing autonomous symbol, order, and position limits', async () => {
    const quotes = new Map([
      ['CC.BTCUSD', { symbol: 'CC.BTCUSD', last: 50_000, bid: 49_900, ask: 50_000 }],
      ['CC.ETHUSD', { symbol: 'CC.ETHUSD', last: 2_000, bid: 1_990, ask: 2_000 }],
      ['CC.DOGEUSD', { symbol: 'CC.DOGEUSD', last: 0.2, bid: 0.19, ask: 0.21 }],
    ])
    const quoteProvider = async (symbol: string) => ({
      ...quotes.get(symbol)!,
      quotedAt: new Date('2026-07-11T00:00:00.000Z'),
    })
    const allowedTool = createCryptoPaperTool({ store: fakeStore(), quoteProvider })
    const allowed = JSON.parse((await allowedTool.execute({
      action: 'buy', decisionSource: 'self', symbol: 'CC.BTCUSD', quantity: 0.09,
      clientOrderId: 'self-btc-001', note: '突破后小仓试错，跌回区间则退出',
    }, ctx())).content as string)
    assert.equal(allowed.ok, true)
    assert.equal(allowed.decisionSource, 'self')

    const symbolRejected = JSON.parse((await allowedTool.execute({
      action: 'buy', decisionSource: 'self', symbol: 'CC.DOGEUSD', quantity: 1,
      clientOrderId: 'self-doge-001', note: '测试非授权币种',
    }, ctx())).content as string)
    assert.equal(symbolRejected.code, 'autonomous_symbol_not_allowed')

    const orderRejected = JSON.parse((await allowedTool.execute({
      action: 'buy', decisionSource: 'self', symbol: 'CC.BTCUSD', quantity: 0.11,
      clientOrderId: 'self-btc-002', note: '测试单笔权益限制',
    }, ctx())).content as string)
    assert.equal(orderRejected.code, 'autonomous_order_limit_exceeded')

    const selfSell = JSON.parse((await allowedTool.execute({
      action: 'sell', decisionSource: 'self', symbol: 'CC.BTCUSD', quantity: 10,
      clientOrderId: 'self-btc-sell', note: '判断失效，主动减少风险',
    }, ctx())).content as string)
    assert.equal(selfSell.ok, true)

    const ownerOtherSymbol = JSON.parse((await allowedTool.execute({
      action: 'buy', decisionSource: 'owner', symbol: 'CC.DOGEUSD', quantity: 1,
      clientOrderId: 'owner-doge-01', note: 'owner 明确授权其他币种测试',
    }, ctx())).content as string)
    assert.equal(ownerOtherSymbol.ok, true)

    const positionTool = createCryptoPaperTool({
      store: fakeStore({
        async getAccount() { return account({ cash: '82000' }) },
        async getPositions() {
          return [{ symbol: 'CC.BTCUSD', quantity: '0.36', averageCost: '45000' }]
        },
      }),
      quoteProvider,
    })
    const positionRejected = JSON.parse((await positionTool.execute({
      action: 'buy', decisionSource: 'self', symbol: 'CC.BTCUSD', quantity: 0.05,
      clientOrderId: 'self-btc-003', note: '测试单币总仓位限制',
    }, ctx())).content as string)
    assert.equal(positionRejected.code, 'autonomous_position_limit_exceeded')

    assert.deepEqual(AUTONOMOUS_CRYPTO_PAPER_SYMBOLS, ['CC.BTCUSD', 'CC.ETHUSD', 'CC.SOLUSD'])
    assert.equal(AUTONOMOUS_CRYPTO_PAPER_MAX_ORDER_EQUITY_RATIO, 0.05)
    assert.equal(AUTONOMOUS_CRYPTO_PAPER_MAX_SYMBOL_EQUITY_RATIO, 0.20)
  })

  test('requires an explicit decision source and trade note', () => {
    const tool = createCryptoPaperTool({
      store: fakeStore(),
      quoteProvider: async () => { throw new Error('not called') },
    })
    assert.equal(tool.schema.safeParse({
      action: 'buy', symbol: 'CC.BTCUSD', quantity: 0.01, clientOrderId: 'btc-buy-004',
    }).success, false)
    assert.equal(tool.schema.safeParse({
      action: 'buy', decisionSource: 'self', symbol: 'CC.BTCUSD', quantity: 0.01,
      clientOrderId: 'btc-buy-005',
    }).success, false)
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
      action: 'buy', decisionSource: 'owner', symbol: 'CC.BTCUSD', quantity: 1,
      clientOrderId: 'btc-buy-002', note: 'owner 明确要求测试余额不足',
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
