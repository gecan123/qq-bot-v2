import { z } from 'zod'
import { Prisma } from '../../generated/prisma/client.js'
import { prisma } from '../../database/client.js'
import { config } from '../../config/index.js'
import type { Tool } from '../tool.js'
import { runMoomooSkillCommand } from './moomoo-skill.js'
import { formatBeijingIso } from '../../utils/beijing-time.js'

const ACCOUNT_ID = 1
const MAX_ORDERS = 100
const MONEY_DP = 12
const QUANTITY_DP = 18

const symbolSchema = z.string().trim().toUpperCase().regex(
  /^CC\.[A-Z0-9]{2,16}USD$/,
  'symbol 必须是 Moomoo Crypto USD 现货币对，例如 CC.BTCUSD 或 CC.ETHUSD',
)
const clientOrderIdSchema = z.string().trim().regex(
  /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/,
  'clientOrderId 必须是 6-64 位稳定 ID，只能包含字母、数字、下划线和连字符',
)

const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('account').describe('查看本地模拟账户资金和配置。') }),
  z.object({ action: z.literal('portfolio').describe('按 Moomoo 当前买一价估算持仓、权益和盈亏。') }),
  z.object({
    action: z.literal('orders').describe('查看模拟成交记录。'),
    limit: z.number().int().min(1).max(MAX_ORDERS).optional().describe('返回最近多少笔，默认 20。'),
    includePreviousGenerations: z.boolean().optional().describe('是否包含 reset 前的历史，默认 false。'),
  }),
  z.object({
    action: z.enum(['buy', 'sell']).describe('按当前买一/卖一价立即模拟成交。'),
    symbol: symbolSchema,
    quantity: z.number().positive().max(1_000_000_000).describe('币数量，必须大于 0。'),
    clientOrderId: clientOrderIdSchema.describe('调用方生成的幂等 ID；重试同一订单时必须复用。'),
    note: z.string().trim().min(1).max(200).optional().describe('可选的交易理由或备注。'),
  }),
  z.object({
    action: z.literal('reset').describe('重置虚拟资金、清空当前持仓并进入新 generation；历史订单保留。'),
    confirm: z.literal(true).describe('只有 owner 明确要求重置时才传 true。'),
  }),
])

type Args = z.infer<typeof argsSchema>
type TradeSide = 'BUY' | 'SELL'

export interface CryptoPaperQuote {
  symbol: string
  last: number
  bid: number
  ask: number
  quotedAt: Date
}

export type CryptoPaperQuoteProvider = (symbol: string) => Promise<CryptoPaperQuote>

export interface CryptoPaperAccountState {
  id: number
  currency: string
  initialCash: string
  cash: string
  realizedPnl: string
  feeRateBps: number
  generation: number
  updatedAt: string
}

export interface CryptoPaperPositionState {
  symbol: string
  quantity: string
  averageCost: string
}

export interface CryptoPaperOrderState {
  id: string
  clientOrderId: string
  generation: number
  symbol: string
  side: TradeSide
  quantity: string
  price: string
  notional: string
  fee: string
  realizedPnl: string
  cashAfter: string
  positionQuantityAfter: string
  status: string
  quoteTime: string | null
  note: string | null
  createdAt: string
}

export interface CryptoPaperStore {
  getAccount(): Promise<CryptoPaperAccountState>
  getPositions(): Promise<CryptoPaperPositionState[]>
  getOrderByClientOrderId(clientOrderId: string): Promise<CryptoPaperOrderState | null>
  listOrders(limit: number, includePreviousGenerations: boolean): Promise<CryptoPaperOrderState[]>
  executeMarketOrder(input: {
    clientOrderId: string
    side: TradeSide
    symbol: string
    quantity: string
    price: string
    quoteTime: Date
    note?: string
  }): Promise<{ order: CryptoPaperOrderState; duplicate: boolean }>
  reset(): Promise<CryptoPaperAccountState>
}

export class CryptoPaperError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'CryptoPaperError'
  }
}

function decimal(value: string | number | Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

function fixed(value: Prisma.Decimal, places = MONEY_DP): Prisma.Decimal {
  return value.toDecimalPlaces(places, Prisma.Decimal.ROUND_HALF_UP)
}

function accountState(row: {
  id: number
  currency: string
  initialCash: Prisma.Decimal
  cash: Prisma.Decimal
  realizedPnl: Prisma.Decimal
  feeRateBps: number
  generation: number
  updatedAt: Date
}): CryptoPaperAccountState {
  return {
    id: row.id,
    currency: row.currency,
    initialCash: row.initialCash.toString(),
    cash: row.cash.toString(),
    realizedPnl: row.realizedPnl.toString(),
    feeRateBps: row.feeRateBps,
    generation: row.generation,
    updatedAt: formatBeijingIso(row.updatedAt),
  }
}

function orderState(row: {
  id: bigint
  clientOrderId: string
  generation: number
  symbol: string
  side: string
  quantity: Prisma.Decimal
  price: Prisma.Decimal
  notional: Prisma.Decimal
  fee: Prisma.Decimal
  realizedPnl: Prisma.Decimal
  cashAfter: Prisma.Decimal
  positionQuantityAfter: Prisma.Decimal
  status: string
  quoteTime: Date | null
  note: string | null
  createdAt: Date
}): CryptoPaperOrderState {
  return {
    id: row.id.toString(),
    clientOrderId: row.clientOrderId,
    generation: row.generation,
    symbol: row.symbol,
    side: row.side as TradeSide,
    quantity: row.quantity.toString(),
    price: row.price.toString(),
    notional: row.notional.toString(),
    fee: row.fee.toString(),
    realizedPnl: row.realizedPnl.toString(),
    cashAfter: row.cashAfter.toString(),
    positionQuantityAfter: row.positionQuantityAfter.toString(),
    status: row.status,
    quoteTime: row.quoteTime ? formatBeijingIso(row.quoteTime) : null,
    note: row.note,
    createdAt: formatBeijingIso(row.createdAt),
  }
}

export function createPrismaCryptoPaperStore(input: {
  initialCash: number
  feeRateBps: number
}): CryptoPaperStore {
  async function ensureAccount() {
    return await prisma.cryptoPaperAccount.upsert({
      where: { id: ACCOUNT_ID },
      create: {
        id: ACCOUNT_ID,
        initialCash: input.initialCash,
        cash: input.initialCash,
        feeRateBps: input.feeRateBps,
      },
      update: { feeRateBps: input.feeRateBps },
    })
  }

  return {
    async getAccount() {
      return accountState(await ensureAccount())
    },

    async getPositions() {
      await ensureAccount()
      const rows = await prisma.cryptoPaperPosition.findMany({
        where: { accountId: ACCOUNT_ID },
        orderBy: { symbol: 'asc' },
      })
      return rows.map((row) => ({
        symbol: row.symbol,
        quantity: row.quantity.toString(),
        averageCost: row.averageCost.toString(),
      }))
    },

    async getOrderByClientOrderId(clientOrderId) {
      const row = await prisma.cryptoPaperOrder.findUnique({ where: { clientOrderId } })
      return row ? orderState(row) : null
    },

    async listOrders(limit, includePreviousGenerations) {
      const account = await ensureAccount()
      const rows = await prisma.cryptoPaperOrder.findMany({
        where: {
          accountId: ACCOUNT_ID,
          ...(includePreviousGenerations ? {} : { generation: account.generation }),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      return rows.map(orderState)
    },

    async executeMarketOrder(orderInput) {
      await ensureAccount()
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "crypto_paper_accounts" WHERE id = ${ACCOUNT_ID} FOR UPDATE`
            const duplicate = await tx.cryptoPaperOrder.findUnique({
              where: { clientOrderId: orderInput.clientOrderId },
            })
            if (duplicate) return { order: orderState(duplicate), duplicate: true }

            const account = await tx.cryptoPaperAccount.findUniqueOrThrow({ where: { id: ACCOUNT_ID } })
            const position = await tx.cryptoPaperPosition.findUnique({
              where: { accountId_symbol: { accountId: ACCOUNT_ID, symbol: orderInput.symbol } },
            })
            const quantity = fixed(decimal(orderInput.quantity), QUANTITY_DP)
            const price = fixed(decimal(orderInput.price), QUANTITY_DP)
            const notional = fixed(quantity.mul(price))
            const fee = fixed(notional.mul(account.feeRateBps).div(10_000))
            const oldQuantity = position?.quantity ?? decimal(0)
            const oldAverageCost = position?.averageCost ?? decimal(0)

            let cashAfter: Prisma.Decimal
            let newQuantity: Prisma.Decimal
            let newAverageCost: Prisma.Decimal
            let realizedPnl = decimal(0)

            if (orderInput.side === 'BUY') {
              const totalCost = fixed(notional.plus(fee))
              if (account.cash.lt(totalCost)) {
                throw new CryptoPaperError(
                  'insufficient_cash',
                  `虚拟现金不足：需要 ${totalCost.toString()} ${account.currency}，当前 ${account.cash.toString()}`,
                )
              }
              cashAfter = fixed(account.cash.minus(totalCost))
              newQuantity = fixed(oldQuantity.plus(quantity), QUANTITY_DP)
              newAverageCost = fixed(
                oldQuantity.mul(oldAverageCost).plus(totalCost).div(newQuantity),
                QUANTITY_DP,
              )
            } else {
              if (!position || oldQuantity.lt(quantity)) {
                throw new CryptoPaperError(
                  'insufficient_position',
                  `持仓不足：要卖 ${quantity.toString()}，当前 ${oldQuantity.toString()}`,
                )
              }
              const netProceeds = fixed(notional.minus(fee))
              realizedPnl = fixed(netProceeds.minus(oldAverageCost.mul(quantity)))
              cashAfter = fixed(account.cash.plus(netProceeds))
              newQuantity = fixed(oldQuantity.minus(quantity), QUANTITY_DP)
              newAverageCost = oldAverageCost
            }

            await tx.cryptoPaperAccount.update({
              where: { id: ACCOUNT_ID },
              data: {
                cash: cashAfter,
                realizedPnl: fixed(account.realizedPnl.plus(realizedPnl)),
              },
            })

            if (newQuantity.isZero()) {
              await tx.cryptoPaperPosition.deleteMany({
                where: { accountId: ACCOUNT_ID, symbol: orderInput.symbol },
              })
            } else {
              await tx.cryptoPaperPosition.upsert({
                where: { accountId_symbol: { accountId: ACCOUNT_ID, symbol: orderInput.symbol } },
                create: {
                  accountId: ACCOUNT_ID,
                  symbol: orderInput.symbol,
                  quantity: newQuantity,
                  averageCost: newAverageCost,
                },
                update: { quantity: newQuantity, averageCost: newAverageCost },
              })
            }

            const created = await tx.cryptoPaperOrder.create({
              data: {
                clientOrderId: orderInput.clientOrderId,
                accountId: ACCOUNT_ID,
                generation: account.generation,
                symbol: orderInput.symbol,
                side: orderInput.side,
                quantity,
                price,
                notional,
                fee,
                realizedPnl,
                cashAfter,
                positionQuantityAfter: newQuantity,
                quoteTime: orderInput.quoteTime,
                note: orderInput.note,
              },
            })
            return { order: orderState(created), duplicate: false }
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        } catch (error) {
          if (error instanceof CryptoPaperError) throw error
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
          if (code === 'P2002') {
            const duplicate = await prisma.cryptoPaperOrder.findUnique({
              where: { clientOrderId: orderInput.clientOrderId },
            })
            if (duplicate) return { order: orderState(duplicate), duplicate: true }
          }
          if (code === 'P2034' && attempt < 2) continue
          throw error
        }
      }
      throw new CryptoPaperError('transaction_conflict', '模拟交易并发冲突，请复用同一 clientOrderId 重试')
    },

    async reset() {
      await ensureAccount()
      return await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "crypto_paper_accounts" WHERE id = ${ACCOUNT_ID} FOR UPDATE`
        const account = await tx.cryptoPaperAccount.findUniqueOrThrow({ where: { id: ACCOUNT_ID } })
        await tx.cryptoPaperPosition.deleteMany({ where: { accountId: ACCOUNT_ID } })
        const updated = await tx.cryptoPaperAccount.update({
          where: { id: ACCOUNT_ID },
          data: {
            cash: account.initialCash,
            realizedPnl: 0,
            generation: { increment: 1 },
          },
        })
        return accountState(updated)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    },
  }
}

function parseSnapshot(stdout: string, requestedSymbol: string): CryptoPaperQuote {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as { data?: Array<Record<string, unknown>> }
      const row = parsed.data?.find((item) => String(item.code).toUpperCase() === requestedSymbol)
      if (!row) continue
      const last = Number(row.last_price)
      const bid = Number(row.bid)
      const ask = Number(row.ask)
      if (![last, bid, ask].every((value) => Number.isFinite(value) && value > 0)) break
      return { symbol: requestedSymbol, last, bid, ask, quotedAt: new Date() }
    } catch {
      // Official SDK logs share stdout; only a complete JSON line is relevant.
    }
  }
  throw new CryptoPaperError('quote_invalid', `Moomoo 没有返回 ${requestedSymbol} 的有效买一/卖一行情`)
}

export function createMoomooCryptoQuoteProvider(): CryptoPaperQuoteProvider {
  return async (symbol) => {
    const moomoo = config.moomoo
    if (!moomoo) throw new CryptoPaperError('quote_not_configured', 'Moomoo Skill 未配置')
    const result = await runMoomooSkillCommand(
      'scripts/quote/get_snapshot.py',
      [symbol, '--json'],
      {
        pythonBin: moomoo.pythonBin,
        skillDir: moomoo.skillDir,
        opendPort: moomoo.opendPort,
        timeoutMs: moomoo.timeoutMs,
        captureCapBytes: 64 * 1024,
      },
    )
    if (result.timedOut) throw new CryptoPaperError('quote_timeout', 'Moomoo Crypto 行情请求超时')
    if (result.exitCode !== 0) {
      throw new CryptoPaperError('quote_failed', result.stderr || result.stdout || 'Moomoo Crypto 行情请求失败')
    }
    return parseSnapshot(result.stdout, symbol)
  }
}

export function createCryptoPaperTool(deps: {
  store: CryptoPaperStore
  quoteProvider: CryptoPaperQuoteProvider
}): Tool<Args> {
  return {
    name: 'crypto_paper',
    description: [
      'crypto_paper 就是 Crypto 模拟盘（paper trading）工具，不是实盘工具，也不需要再等待或寻找另一个“模拟盘工具”.',
      '它维护本地虚拟资金、持仓和成交，只用 Moomoo CC.*USD 行情，绝不调用 Moomoo Crypto 实盘交易接口.',
      'action=buy/sell 按当前卖一/买一立即成交；必须提供稳定 clientOrderId，重试同一意图时复用它以避免重复成交.',
      'action=account/portfolio/orders 查询资金、持仓、盈亏和成交；action=reset 仅在 owner 明确要求后使用.',
      '没有用户明确交易意图时，不得根据行情自主买卖；市场研究和观点记录不是下单授权.',
      '当前只支持现货多头和市价模拟成交，不支持限价单、做空、杠杆或真实资金.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      try {
        const args = argsSchema.parse(rawArgs)
        if (args.action === 'account') {
          return { content: JSON.stringify({ ok: true, liveTrading: false, account: await deps.store.getAccount() }) }
        }
        if (args.action === 'orders') {
          const orders = await deps.store.listOrders(args.limit ?? 20, args.includePreviousGenerations ?? false)
          return { content: JSON.stringify({ ok: true, liveTrading: false, orders }) }
        }
        if (args.action === 'reset') {
          const account = await deps.store.reset()
          return { content: JSON.stringify({ ok: true, liveTrading: false, reset: true, account }), outcome: { ok: true } }
        }
        if (args.action === 'portfolio') {
          const [account, positions] = await Promise.all([
            deps.store.getAccount(),
            deps.store.getPositions(),
          ])
          const priced = await Promise.all(positions.map(async (position) => {
            const quote = await deps.quoteProvider(position.symbol)
            const quantity = decimal(position.quantity)
            const averageCost = decimal(position.averageCost)
            const marketValue = fixed(quantity.mul(quote.bid))
            const estimatedExitFee = fixed(marketValue.mul(account.feeRateBps).div(10_000))
            const costBasis = fixed(quantity.mul(averageCost))
            const unrealizedPnl = fixed(marketValue.minus(estimatedExitFee).minus(costBasis))
            return {
              ...position,
              last: String(quote.last),
              bid: String(quote.bid),
              ask: String(quote.ask),
              marketValue: marketValue.toString(),
              estimatedExitFee: estimatedExitFee.toString(),
              unrealizedPnl: unrealizedPnl.toString(),
              quotedAt: formatBeijingIso(quote.quotedAt),
            }
          }))
          const liquidationValue = priced.reduce(
            (sum, position) => sum.plus(position.marketValue).minus(position.estimatedExitFee),
            decimal(0),
          )
          const equity = fixed(decimal(account.cash).plus(liquidationValue))
          const unrealizedPnl = fixed(priced.reduce(
            (sum, position) => sum.plus(position.unrealizedPnl),
            decimal(0),
          ))
          return {
            content: JSON.stringify({
              ok: true,
              liveTrading: false,
              pricing: 'moomoo_bid_liquidation',
              account,
              equity: equity.toString(),
              realizedPnl: account.realizedPnl,
              unrealizedPnl: unrealizedPnl.toString(),
              totalPnl: equity.minus(account.initialCash).toString(),
              positions: priced,
            }),
          }
        }

        const existing = await deps.store.getOrderByClientOrderId(args.clientOrderId)
        if (existing) {
          return {
            content: JSON.stringify({ ok: true, liveTrading: false, duplicate: true, order: existing }),
            outcome: { ok: true },
          }
        }
        const quote = await deps.quoteProvider(args.symbol)
        const side: TradeSide = args.action === 'buy' ? 'BUY' : 'SELL'
        const price = side === 'BUY' ? quote.ask : quote.bid
        const result = await deps.store.executeMarketOrder({
          clientOrderId: args.clientOrderId,
          side,
          symbol: args.symbol,
          quantity: String(args.quantity),
          price: String(price),
          quoteTime: quote.quotedAt,
          note: args.note,
        })
        return {
          content: JSON.stringify({
            ok: true,
            liveTrading: false,
            pricing: side === 'BUY' ? 'moomoo_ask' : 'moomoo_bid',
            duplicate: result.duplicate,
            order: result.order,
          }),
          outcome: { ok: true },
        }
      } catch (error) {
        if (error instanceof CryptoPaperError) {
          return {
            content: JSON.stringify({ ok: false, liveTrading: false, code: error.code, error: error.message }),
            outcome: { ok: false, code: error.code, error: error.message },
          }
        }
        throw error
      }
    },
  }
}

export function maybeCreateCryptoPaperTool(): Tool<Args> | null {
  const paper = config.cryptoPaper
  if (!paper || !config.moomoo) return null
  return createCryptoPaperTool({
    store: createPrismaCryptoPaperStore(paper),
    quoteProvider: createMoomooCryptoQuoteProvider(),
  })
}
