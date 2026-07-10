# NapCat 合并转发消息解析设计

## 目标

让入站 QQ 消息中的 `forward` 段在首次处理时展开为有界、可持久化、可确定性 replay 的消息树，使 Agent 能读取转发正文，而不是只看到 `[forward]`。

设计只借鉴 Lynn 的解析思路：先取得转发子消息，再用 `get_msg` 补全每个子消息，失败时回退到 `get_forward_msg` 或事件内嵌的子消息数据。不会引入 Lynn 的 `MessageEntry`、`Condition` 或可变 `formated.items` 模型。

## 数据流

1. 顶层消息仍由 ingress 调用 `get_msg` 获取。
2. 同步基础解析识别 `forward` 段并保留 `forwardId`。
3. 异步展开器优先使用合法的事件内嵌子消息；否则调用 `get_forward_msg`。
4. 对每个带有效 `message_id` 的子消息调用 `get_msg` 获取规范消息；调用失败时使用已有子消息对象。
5. 子消息的 segments 复用同一解析逻辑，因此嵌套 `forward` 也会递归展开。
6. 嵌套媒体沿用当前媒体缓存、描述和 handle 流程。
7. 展开后的结构化 `content` 与顶层消息一起写入 `messages`；inbox、search 和 replay 只使用已持久化结果，不重新请求 NapCat。

## 结构

新增 `ForwardSegment`：

```ts
interface ForwardSegment {
  type: 'forward'
  forwardId: string
  items: ForwardMessageItem[]
  truncated?: boolean
  unavailable?: boolean
}

interface ForwardMessageItem {
  messageId?: string
  senderId?: string
  senderName?: string
  time?: number
  content: ParsedSegment[]
}
```

`unavailable` 只表达转发内容未能取得，不持久化瞬时异常文本。`truncated` 明确披露深度、条数或文本预算已经生效。

## 边界与确定性

- 最大嵌套深度为 3。
- 一棵转发消息树最多展开 50 条子消息。
- 每条转发子消息最多保留 2,000 个文本字符。
- 子消息按 NapCat 返回顺序解析和渲染。
- 同一棵树内相同 `message_id` 的 `get_msg` 只请求一次。
- 获取失败只影响对应子消息或转发段，不让整条顶层消息入库失败。
- 转发内部的 `@bot` 不计为顶层入站消息的 `mentionedSelf`，避免历史转发触发高优先级唤醒。

## 文本与媒体

`segmentsToPlainText` 将转发结构渲染为稳定的嵌套文本，包含发送者和子消息正文。达到边界时输出明确的“已截断”标记；不可用时输出“内容不可用”。

媒体持久化和描述解析递归遍历 `ForwardSegment.items[].content`。inbox 的 `media` handles 也按消息树顺序递归披露，但顶层 mention 判断保持不递归。

## 测试

- `forward` 段能通过 `get_forward_msg` 展开。
- 每个有效子消息调用 `get_msg`，并使用补全结果。
- `get_msg` 失败时回退已有子消息。
- 嵌套转发递归展开，并遵守深度、总条数和文本上限。
- 转发文本稳定渲染。
- 嵌套媒体能持久化、解析描述并从 inbox 暴露 handle。
- focused tests、`pnpm typecheck` 和 `pnpm repo-check` 全部通过，且不启动真实 NapCat、QQ、数据库或长期进程。
