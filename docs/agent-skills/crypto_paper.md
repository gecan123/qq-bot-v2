---
name: crypto_paper
description: 当需要用 Moomoo Crypto 行情进行本地虚拟资金买卖、查看持仓或统计盈亏时使用；Luna 可在长期授权边界内自主经营 BTC/ETH/SOL 模拟仓，其他订单仍需用户明确授权；不要使用任何实盘路径。
---

# Crypto 本地模拟仓

`crypto_paper` 是 typed tool。资金、持仓和成交只保存在本地 PostgreSQL；价格来自 Moomoo `CC.*USD` 行情，但不会创建 `OpenCryptoTradeContext`，不会解锁交易，也不会触碰真实 Crypto 账户。

## 查询

- `action=account`：查看虚拟现金、初始资金、已实现盈亏、手续费率和 generation。
- `action=portfolio`：按当前买一价估算清算价值、未实现盈亏和总权益。
- `action=orders`：查看最近模拟成交；默认只看当前 generation。

查询不构成交易，不需要额外确认。

## 市价模拟成交

- 买入使用 Moomoo 当前卖一价，卖出使用当前买一价。
- 只支持 `CC.<币种>USD` 现货币对，例如 `CC.BTCUSD`、`CC.ETHUSD`。
- 只支持多头；不支持负现金、裸卖空、杠杆、限价单或自动撮合。
- 买卖都收取配置的模拟手续费。
- 每次买卖必须提供 6–64 位 `clientOrderId`。同一交易意图重试时必须复用原 ID；工具会返回原成交，不会重复扣款。
- 每笔买卖都必须提供 `decisionSource=owner|self` 和真实 `note`，不能把工具试用或“保持活跃”写成交易理由。

### 用户明确授权的订单

`decisionSource=owner` 只用于用户已经明确表达币种、方向和数量的模拟订单；信息不完整时先询问，不要猜数量。普通证券 Moomoo 模拟仓仍然只接受这种逐次授权。

### Luna 自主经营的本地 Crypto 模拟仓

`decisionSource=self` 使用 owner 已授予的长期自主权限，不需要逐笔询问，但必须同时满足：

- 只允许 `CC.BTCUSD`、`CC.ETHUSD`、`CC.SOLUSD`；
- 增加仓位时，单次买入成本（含模拟手续费）不超过当前权益的 5%；
- 买入后单币仓位价值不超过当前权益的 20%；
- 减仓和退出不受开仓额度阻止，但不能卖出超过当前持仓的数量；
- 下单前先在 `notebook kind=market` 写清判断、证据和失效条件；
- 成交后可以选择一个相关熟人或群，明确说明是模拟仓并分享判断，不同时广播多个目标；
- 后续只在价格、证据或判断发生真实变化时查看并复盘，不机械轮询；
- 自主权限不包括 `reset`，也不扩展到普通证券模拟仓或任何实盘。

## 重置

`action=reset` 会恢复初始虚拟资金、清空当前持仓并增加 generation。历史订单仍保留。只有 owner 明确要求重置模拟仓时才能传 `confirm=true`。

## 与 Moomoo 的边界

- Crypto 行情可以通过本工具内部价格源读取。
- 普通证券模拟仓使用 finance capability 的 `moomoo_skill`，并显式传 `--trd-env SIMULATE`。
- 不允许调用 `place_crypto_order.py`、`cancel_crypto_order.py`、`unlock_trade` 或任何 Crypto 实盘接口。
- 工具结果始终包含 `liveTrading=false`；若出现行情失败，应返回错误，不得降级到实盘或凭空编价格。
