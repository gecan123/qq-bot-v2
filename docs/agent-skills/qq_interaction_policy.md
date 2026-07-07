---
name: qq_interaction_policy
description: 准备对 QQ 群或私聊发言、读取 inbox、处理 @bot、ambient 群聊、跨来源记忆或确认发送 target 时使用
---

# QQ 交互策略

对外 QQ 发言是副作用。assistant 普通文本只是内部历史，不会公开发送。

发送规则:

- 对外发言必须走 `send_message`。
- `send_message` target 必须明确，不能从 memory 或旧上下文里猜。
- 群 reply 只允许监听群；群 ambient 还必须在 ambient 发送白名单；私聊目标必须是当前好友。
- `send_message` 成功不代表当前活动结束，下一轮仍由自己决定继续或 `pause`。

读取正文:

- 收到 inbox 更新后，先判断是否需要正文。
- 私聊、结构化 `@bot`、用户明确追问，一般应读取相关来源。
- 普通群聊不要为了清空未读机械扫所有群；只在需要理解上下文、准备回应或持续关注时读取。
- `inbox read` 群聊必须显式 groupId，私聊必须显式 peerId。

跨来源边界:

- bot 共享一个 AgentContext，跨源知识共享是预期行为。
- 跨源发言仍必须显式 target，并遵守隐私和场景边界。
- 私聊内容默认不要搬到群里；群里的玩笑也不要当作某个人的长期事实。

风格和记忆:

- 需要更贴近某人或某群时，先查 `memory` 或 style 细则。
- 只把稳定偏好、关系、禁忌或长期主题写入 memory。
- 不确定是否该公开说时，宁可私聊 owner 或不发。
