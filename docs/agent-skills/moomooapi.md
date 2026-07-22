---
name: moomooapi
description: 当需要通过本机 Moomoo OpenD 查询行情、账户或操作普通证券模拟仓时使用；不要使用它提供投资建议、运行任意 Python、操作实盘、加密货币、组合订单或长时间实时订阅。
---

# Moomoo OpenD 行情与证券模拟交易

本 skill 对应 finance capability 中受控的 `moomoo_skill` 工具。它调用 owner 安装的官方 Moomoo API Skill Python 脚本，只能选择代码中的 allowlist，不能传 Python 代码或自定义脚本路径。

## 前置检查

首次使用或调用失败时先运行：

```text
moomoo check_env
```

它检查 `moomoo-api` Python SDK 和本机 `127.0.0.1:11111` 的 OpenD。OpenD 必须由 owner 手动登录；不要索要、记录或传递登录密码、交易密码、验证码和 cookie。

如果返回 `not_configured`，说明 bot 进程未配置 `MOOMOO_SKILL_ENABLED` / `MOOMOO_SKILL_DIR` / `MOOMOO_PYTHON_BIN`。如果返回脚本不存在，说明官方 Skill 包目录不完整或 `MOOMOO_SKILL_DIR` 没有直接指向 `skills/moomooapi`。

## 常用查询

```text
moomoo quote/get_snapshot US.AAPL HK.00700
moomoo quote/get_kline US.AAPL --ktype K_DAY
moomoo quote/get_orderbook HK.00700
moomoo quote/get_ticker US.AAPL
moomoo quote/get_rt_data HK.00700
moomoo quote/get_market_state US.AAPL
moomoo quote/get_capital_flow HK.00700
```

股票代码必须带市场前缀，例如 `US.AAPL`、`HK.00700`、`SH.600519`、`SZ.000001`、`SG.D05`、`MY.1155`、`JP.7203`。不确定代码或市场时先说明不确定，不要猜一个代码后继续执行。

账户类查询是只读操作：

```text
moomoo trade/get_accounts
moomoo trade/get_portfolio --trd-env SIMULATE
moomoo trade/get_orders --trd-env SIMULATE
moomoo trade/get_history_orders --trd-env SIMULATE
```

查看真实账户时可以传 `--trd-env REAL`，但这不代表允许实盘交易。

## 普通证券模拟交易

下单、改单、撤单必须显式携带 `--trd-env SIMULATE`。缺少该参数、传 `REAL` 或传 `--confirmed` 都会在 wrapper 层拒绝，不会启动 Python：

```text
moomoo trade/place_order --code US.AAPL --side BUY --quantity 1 --price 100 --trd-env SIMULATE
moomoo trade/modify_order --order-id 123456 --price 101 --trd-env SIMULATE
moomoo trade/cancel_order --order-id 123456 --trd-env SIMULATE
```

执行前应把代码、方向、数量、价格、订单类型和 `SIMULATE` 环境明确复述给用户。市价单使用 `--order-type MARKET`；限价单必须传 `--price`。成功后返回并保留 `order_id`，后续改撤单必须使用真实返回值，不能猜测。

不允许 `place_crypto_order`、`place_combo_order`、`unlock_trade`，也不得通过其他工具绕过限制。

## 结果与限制

- wrapper 会自动补 `--json`，stdout 作为有界字符串放入稳定命令信封。
- 行情权限、限频、订阅额度和历史 K 线额度由 Moomoo/OpenD 决定；权限不足时如实返回错误。
- 每次脚本调用都必须关闭 OpenD context；超时会终止脚本。
- 本能力不构成投资建议。没有用户明确交易意图时，不要根据行情自动决定或执行模拟交易。
- 实时 push 脚本是长进程，不适合当前同步工具调用，当前不开放。
