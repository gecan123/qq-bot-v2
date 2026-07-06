# Agent 自主生活循环设计

## 目标

让 Luna 把 QQ 群聊视为生活环境之一，而不是唯一任务来源。Agent 在一次行动机会内可以自己延续兴趣、安排休息和决定下次醒来；发送消息不再隐式结束当前生活周期。

## 运行模型

- `curiosity_tick` 只保留为人工调试入口，不承担生产自主性。
- `send_message status=sent` 只是一个成功动作，BotLoop 继续下一轮，由 Agent 决定继续做事还是休息。
- `pause action=rest` 是 Agent 自己安排下次醒来的接口。计时由工具内部完成；私聊、`@bot`、后台任务完成和停止信号仍可提前打断。
- `pause` 增加 `intention`，把醒来后准备继续的事情写入稳定 tool result；这让后续一轮能够沿着自己的念头继续，而不是重新依赖群聊触发。
- 群聊、私聊、外部研究、journal、memory、todo、创作和代码自审都是可选生活来源。没有公开发言必要时可以只做事。

## 自主安全边界

- 主动休息范围为 30 秒到 6 小时，默认 5 分钟。
- 连续 20 个未主动休息的 LLM round 后，runtime 自动冷却 60 秒，防止失控空转；需要注意的外部事件可提前打断。
- 每个北京时间自然日设置 200,000 token 的自主循环预算。预算耗尽后，无新披露事件时休眠到次日；外部事件仍允许进入并处理。
- 预算和连续轮次是运行控制状态，不写入 `AgentContext.messages`，不参与 replay，也不改变历史 prompt 字节。
- 默认值先作为集中常量实现，测试可注入更小值和 fake clock/timer；后续确有运维需求再提升为配置项。

## Prompt 契约

- tick 是调试唤醒方式，不是好奇心来源。
- 是否有人 `@` 不决定 Agent 是否有事可做。
- 每轮应在继续当前兴趣、开始新兴趣或调用 `pause` 安排休息之间做选择。
- 不向 QQ 用户解释内部 tick、事件队列或“等系统推送”等运行机制。

## 验证

- `pause` schema、计时、提前唤醒和 intention tool result 测试。
- BotLoop 测试证明发送成功后继续下一轮，并由 `pause` 决定休息。
- BotLoop 测试证明连续轮次冷却、事件打断和每日预算边界。
- system prompt 测试锁定自主生活语义。
- focused tests、typecheck、repo-check 和 diff 检查。
