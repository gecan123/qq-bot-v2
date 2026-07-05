# 私聊 Mailbox 披露设计

## 目标

私聊和普通群聊采用同一种 mailbox 渐进式披露模型。所有私聊消息不再自动把正文写入 `AgentContext`，而是按联系人生成不含正文的 inbox 通知；Agent 需要正文时，通过现有 `inbox` 工具按明确联系人读取。

群内 `@bot` 消息仍保持 direct 披露，不改变现有实时响应语义。

## 披露规则

- 私聊：按 `peerId` 划分为独立 mailbox，key 为 `qq_private:<peerId>`。同一次 event drain 中，同一联系人发来的多条消息聚合为一条通知。
- 普通群消息：继续按 `groupId` 聚合为 mailbox 通知。
- 群内 `@bot`：继续直接渲染正文并 append 到 `AgentContext`。
- 非 QQ 事件：保持现有 direct 行为。

私聊通知包含联系人标签、mailbox key、消息数量、row-id 范围、时间范围和读取指引，不包含消息正文。读取指引使用 `inbox action=read source=private peerId=<peerId> afterRowId=<rowId>`。

## 代码边界

`src/agent/mailbox.ts` 中的 mailbox 批次从“仅普通群消息”泛化为“普通群消息或私聊消息”。渲染函数根据事件类型生成群聊或私聊通知，但共享聚合、游标推进和稳定排序逻辑。

`src/agent/bot-loop-agent.ts` 继续只区分 direct 与 mailbox 通知，不增加私聊专用分支。`messages`、`mailboxCursors`、snapshot 原子保存和 replay 查询结构不变，因为现有数据模型已经为每个 `qq_private:<peerId>` 保存独立游标。

现有 `inbox` 工具已经支持 `source=private` 和显式 `peerId`，无需新增工具或修改数据库 schema。

## 数据流

1. 私聊入站消息照常写入不可变 `messages` 事实账本并进入 event queue。
2. mailbox planner 按 `qq_private:<peerId>` 过滤 cursor 已覆盖的消息，并在本次 drain 内按联系人聚合。
3. bot loop 只把稳定的私聊 inbox 通知 append 到 `AgentContext`，同时推进对应联系人 cursor。
4. Agent 调用 `inbox action=read source=private peerId=...` 后，正文通过有界 tool result 进入上下文。

## 错误与边界处理

- 空批次继续拒绝渲染。
- 同一 drain 内不同联系人不得合并。
- 私聊通知不得包含 `renderedText`。
- cursor 按每个 mailbox 的最大 `messageRowId` 单调推进。
- replay 产生的私聊事件与 live 私聊事件走同一 planner，不建立第二套披露逻辑。

## 验证

- mailbox 单元测试：私聊转为通知、同联系人聚合、不同联系人隔离、通知不泄露正文、读取指引正确。
- bot-loop 测试：私聊正文不进入 `AgentContext`，私聊 cursor 正确保存。
- 多来源集成测试：群内 `@bot` 保持 direct，普通群和私聊都以各自 mailbox 通知出现。
- replay 测试：确认私聊 replay 仍按独立 cursor 入队，并最终走相同通知路径。
- 同步更新 `docs/AGENT_CONTEXT.md`、`docs/ARCHITECTURE.md` 和相关注释。
- 运行 focused tests、`pnpm typecheck`、`pnpm repo-check`、`git diff --check`。

## 非目标

- 不改变群内 `@bot` 的 direct 披露。
- 不改变 `send_message` 私聊发送语义。
- 不修改数据库 schema、snapshot schema 或 inbox 工具参数。
- 不迁移或改写已经存在于 `AgentContext` 中的历史私聊正文。
