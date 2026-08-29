# QQ 超长文本折叠与合并转发 API 研究（2026-08-29）

## 结论

最适合这个场景的不是“先由 qq-bot-v2 发到另一个群，再拿消息 ID 转发”，而是：

1. 在 QQ egress 判断“群聊 + 纯文本 + 超过产品阈值”；
2. 把正文按章节、段落或有界字符数拆成若干个 OneBot `node` 自定义节点；
3. 仍调用现有 `send_group_msg`，但让 `message` 数组 **全部都是 `node`**；也可以调用等价的 NapCat 扩展 `send_group_forward_msg`。

NapCat v4.18.19 的 `SendMsgBase` 会检查 node 不能与普通消息段混发，并在发现 node 后直接进入合并转发分支；`send_group_msg` 本身继承这条逻辑，所以不一定需要接入一个新的 OneBot action。[NapCat v4.18.19 `SendMsgBase`](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/msg/SendMsg.ts#L127-L190)；[`SendGroupMsg`](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/group/SendGroupMsg.ts#L7-L23)

这会让 QQ 客户端收到一条“聊天记录”卡片，默认摘要是“查看 N 条转发消息”，用户点击后阅读正文；Packet 模式下 NapCat 生成的卡片类型明确是 `com.tencent.multimsg`，默认 `summary` 也由节点数生成。[NapCat `ForwardMsgBuilder`](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-core/helper/forward-msg-builder.ts#L52-L100)

没有找到 OneBot 11 或 NapCat 的公开 action / 消息段，能给普通 `text` 加一个稳定的“默认折叠、点击展开”标志。公开协议里对应这种交互的稳定消息形态就是 `forward` / `node` 合并转发。QQ 客户端是否自行折叠某些超长普通文本属于客户端呈现，不是当前 NapCat/OneBot 可请求的契约。[OneBot 11 消息段目录中的 `forward` / `node`](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/message/segment.md#L410-L491)；[NapCat v4.18.19 消息段 schema](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/types/message.ts#L214-L307)

## 可直接构造合并转发，无需手工暂存

OneBot 11 定义了两种发送节点：

- 引用节点：`{"type":"node","data":{"id":"123456"}}`，引用一条已有消息；
- 自定义节点：`{"type":"node","data":{"user_id":"...","nickname":"...","content":[...]}}`，`content` 直接使用普通发送消息的数组格式。

因此小说正文可以直接放进自定义节点的 `content`，不需要业务代码先制造真实 QQ 消息。[OneBot 11 引用节点与自定义节点规范](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/message/segment.md#L429-L491)

建议的请求形状是：

```json
{
  "group_id": "123456789",
  "message": [
    {
      "type": "node",
      "data": {
        "user_id": "机器人QQ号",
        "nickname": "Luna · 1/3",
        "content": [
          { "type": "text", "data": { "text": "第一段正文……" } }
        ]
      }
    },
    {
      "type": "node",
      "data": {
        "user_id": "机器人QQ号",
        "nickname": "Luna · 2/3",
        "content": [
          { "type": "text", "data": { "text": "第二段正文……" } }
        ]
      }
    }
  ]
}
```

可以把它传给：

- `send_group_msg`：最贴合本仓库当前 egress，NapCat 识别 node-only 数组后自动转合并转发；
- `send_group_forward_msg`：NapCat 的 Go-CQHTTP 兼容 action，强制群聊 context；
- `send_forward_msg`：按 `group_id` 或 `user_id` 选择目标；
- `send_private_forward_msg`：私聊版本。

后三者只是同一 `SendMsgBase` 的薄包装；`messages` 是兼容别名，当前实现会先归一化到 `message`。本仓库声明并安装的 `node-napcat-ts@0.4.21` 也把这些发送接口的字段声明为 `message: NodeSegment[]`，所以新代码应优先使用单数 `message`。[NapCat 转发 action 实现](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/go-cqhttp/SendForwardMsg.ts#L5-L66)；[NapCat v4.18.19 API 文档](https://napneko.github.io/api/4.18.19)；[本仓库 `package.json`](../../package.json)

需要注意：`send_forward_msg` / `send_group_forward_msg` 不是 OneBot 11 核心公开 API，而是 NapCat 标为 `Go-CQHTTP` 的兼容扩展；OneBot 11 核心规范定义了 node 格式和只读的 `get_forward_msg`，但没有这三个发送 action。[OneBot 11 公开 API](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/public.md)；[NapCat action 标签](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/go-cqhttp/SendForwardMsg.ts#L14-L66)

## “先发给自己再转发”实际由 NapCat 内部处理

NapCat v4.18.19 有两条实现路径：

### PacketBackend 可用

NapCat 把自定义节点直接转换为 packet message，上传 long-message 数据，再生成 `com.tencent.multimsg` Ark 并发送到目标。这个分支不需要先在某个聊天里制造节点消息；嵌套转发最多处理三层。[Packet 分支选择](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/msg/SendMsg.ts#L166-L175)；[自定义节点转换、三层上限与上传](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/msg/SendMsg.ts#L224-L345)

### PacketBackend 不可用

NapCat 为自定义节点建立 `selfPeer`（机器人自己的 C2C 会话），调用普通 `sendMsg` 生成真实节点消息，再把这些消息 ID 合并转发到目标。也就是说，用户提出的“先发给自己，再转发”是可行的，但当前 NapCat 已经在一个 API 调用内部做了，不需要 qq-bot-v2 再暴露第二个 target 或寻找“空白群”。[NapCat 非 Packet 自定义节点暂存](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/msg/SendMsg.ts#L368-L435)；[最终 `multiForwardMsg`](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/msg/SendMsg.ts#L437-L480)

这个分支的代价是：机器人“与自己聊天”的记录里可能留下暂存消息；如果节点已生成而最终合并转发失败，也没有事务式回滚。是否启用了 PacketBackend 是运行配置和 QQ 版本相关的当前状态，本研究没有启动 Bot 或发真实消息验证。

## 已有消息 ID 转发的适用范围

引用已有消息 ID 是规范支持的，但不适合生成小说的主路径：

- NapCat 先用 `MessageUnique` 把 OneBot 短 ID 或原始 msgId 解析回 `Peer + MsgId`；找不到就跳过该节点；
- 这个映射是进程内、最多 5000 条的两个 `Map`，不是可持久依赖；NapCat 重启或旧映射淘汰后，旧 ID 不一定还能引用；
- 同一来源 peer 的已有消息可以直接 `multiForwardMsg`；来源不一致时 NapCat 会先 clone 到自己的 C2C，再合并转发。

依据见 [引用 ID 的解析与跨 peer clone](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/msg/SendMsg.ts#L269-L315) 和 [`MessageUnique` 的 5000 条内存映射](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-common/src/message-unique.ts#L78-L147)。另外，OneBot 11 的 id-only node 是合法格式，但 NapCat v4.18.19 的公开 TypeBox schema 同时把 `nickname`、`content` 标成必填，和内部确实存在的 id 分支不完全一致；因此不要围绕 id-only 请求设计新功能，除非先在实际运行版本验证这处兼容行为。[NapCat node schema](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/types/message.ts#L278-L297)

## `get_forward_msg` 只负责读取

OneBot 11 的 `get_forward_msg` 输入是合并转发 `id`，返回由 node 组成的消息数组；它不是“上传正文再取得 forward id”的创建 API。[OneBot 11 `get_forward_msg`](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/public.md#L123-L135)

NapCat v4.18.19 兼容 `id` 或 `message_id`，响应字段是 `messages`，并优先按当前 `MessageUnique` 找原消息；非数字 resId 才走协议下载回退。[NapCat `GetForwardMsg`](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/go-cqhttp/GetForwardMsg.ts#L10-L19)；[读取路径](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/go-cqhttp/GetForwardMsg.ts#L76-L160)

本仓库已经按 NapCat 的实际响应读取 `messages`，并对嵌套深度、总节点数和单节点文本做接收入站限制；这与本次发送设计无冲突。[`src/bot/message-parser.ts`](../../src/bot/message-parser.ts)

## 自定义节点与卡片参数的限制

- node 必须独占本次 `message` 数组；普通 `text`、`reply`、图片等不能作为 node 的兄弟消息段混发。它们可以放进 node 自己的 `content`。[NapCat node-only 校验](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/msg/SendMsg.ts#L136-L145)
- Packet 分支的嵌套 node 深度上限是 3；小说不需要嵌套，保持一层即可。[NapCat 深度检查](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/msg/SendMsg.ts#L224-L238)
- NapCat 没有在公开 schema 中给出稳定的“每 node 最大字符数 / 最大 node 数”。不要把未文档化的 QQ 上限当产品契约；应由 qq-bot-v2 做保守分块，并用一次真实 QQ 测试校准。
- `source`、`news`、`summary`、`prompt` 是 NapCat 扩展，在 Packet 分支会进入卡片 builder，但非 Packet 的 QQ 原生合并转发路径不会读取这些字段。2026 年维护者还把这类自定义预览受限归因于“腾讯限制”，所以功能不应依赖伪造标题或摘要才能成立。[Packet builder 调用](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/msg/SendMsg.ts#L324-L345)；[NapCat Discussion #1655](https://github.com/NapNeko/NapCatQQ/discussions/1655)

## Ark、小程序、Markdown 不适合代替合并转发

### Markdown

NapCat 声明了 `markdown` 消息段，也会构造 QQ `MARKDOWN` element，但发送转换器旁明确写着 `Need signing`。它不是 OneBot 11 标准折叠容器，也没有“收起/展开”参数；普通个人 QQ 账号上的兼容性不应在未实测时假定。[NapCat Markdown schema](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/types/message.ts#L235-L241)；[Markdown 发送转换器](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/api/msg.ts#L818-L823)

### Ark / JSON 卡片

NapCat 的 `json` 消息段会直接变成 Ark element。理论上可以手写 Ark JSON，但合并转发卡片还需要先上传 long-message 内容并拿到有效 resId；只伪造 `com.tencent.multimsg` 外壳不能替代 `send_group_forward_msg` 的上传流程。[JSON 到 Ark 的转换](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/api/msg.ts#L776-L784)；[合并转发上传与 resId](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/msg/SendMsg.ts#L320-L345)

### 小程序

NapCat 虽声明 `miniapp` 消息段，但普通消息转换器当前直接返回 `undefined`。扩展 `get_mini_app_ark` 依赖 PacketBackend，要求标题、描述、图片和跳转 URL（或完整 app/template 参数），返回的是一张分享卡片的 Ark 数据；它适合链接到外部阅读页，不适合承载本地生成的整篇小说。[`miniapp` 当前不发送](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/api/msg.ts#L920-L935)；[`get_mini_app_ark` 参数和实现](https://github.com/NapNeko/NapCatQQ/blob/af07479351c5b974e72ae1c7183f2272e79ffc1c/packages/napcat-onebot/action/extends/GetMiniAppArk.ts#L7-L100)

## 建议落到 qq-bot-v2 的最小设计

当前出站叶节点无论群聊还是私聊都只调用 `send_group_msg` / `send_private_msg`，而 `NapcatSegment.data` 只允许标量，不能类型安全地表达 node 里的嵌套 `content`。[`src/messaging/napcat-sender.ts`](../../src/messaging/napcat-sender.ts)

后续实现建议保持在现有 QQ egress seam 内：

1. 只对 **群聊、ambient、纯文本** 生效。包含 `reply`、图片、音乐或其他结构时保留原发送语义，不要为了折叠丢掉引用关系。
2. 先用一个明确的产品阈值，例如 1200～1500 个 Unicode 字符；这不是 QQ 协议上限，只是群聊 UX 起点，最好根据真实发送样本再调整。
3. 按章节标题、空行和段落边界分块；单块仍过长时再按约 1500～2500 字符切开。每块一个 node，nickname 可标记 `Luna · 1/N`。这样即使 NapCat 走非 Packet 暂存路径，每个底层普通文本也有界。
4. 给总节点数和总字符数一个保守上限。上游没有稳定公开上限；超出时明确失败或改用文件/外部阅读页，不要静默截断小说。
5. 扩展当前 outbound 类型为能表达嵌套 node 的联合类型，或给 `MessageSender` 增加窄的 `sendForwardText` 方法；不要继续用 `as never` 掩盖新的嵌套数据契约。
6. 保持一次对外 delivery 只有一个 NapCat action。不要在 qq-bot-v2 里显式“先发自己、再发群”形成两次独立副作用；让 NapCat 内部处理。
7. 实现后需要一次用户明确授权的真实 QQ 验证，至少覆盖 PacketBackend 当前可用/不可用状态、桌面与移动端折叠展示、超长中文、失败是否留下自聊暂存、以及发送响应丢失时是否可能重复卡片。本研究没有启动或重启 Bot，也没有发送测试消息。

## 版本口径

本研究以 **2026-08-29** 可查到的最新正式版 NapCat **v4.18.19**（2026-08-14 发布）及其 release commit `af07479351c5b974e72ae1c7183f2272e79ffc1c` 为主；同时核对了当前 main，相关转发 action、schema 和两条发送路径没有变化。[NapCat v4.18.19 release](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.19)

仓库此前的故障研究记录本机运行实例是 v4.17.52；该版本的上述转发 action 和两条实现路径与 v4.18.19 相同，但真实运行版本、PacketBackend 状态和 QQ 客户端效果都属于易变化状态，实施前应重新只读确认。[本机版本记录](./napcat-sendmsg-timeout-2026-08-26.md)
