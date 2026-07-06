# 入站媒体 Handle 与工具引导优化设计

## 目标

让 Luna 在通过 `inbox` 读取 QQ 图片消息时直接获得可用于收藏和发送的稳定 `mediaId`，同时消除 `collect_sticker` 在常驻工具与 deferred capability 之间的重复注册和提示词冲突。

## 设计

`inbox action=read` 返回的每条消息新增结构化 `media` 数组。数组按原消息 segment 顺序投影媒体引用，每项包含媒体类型和正整数 `mediaId`。文本字段继续使用已经冻结的 `resolvedText`，不把 handle 拼进自然语言描述，避免下游解析展示文本。

首期覆盖已具备稳定数据库引用的 `image`、`video`、`record` 和 `file` segment。缺少合法 `referenceId` 的 segment 不进入数组。没有媒体的消息返回空数组，使响应 schema 对所有消息保持一致、可预测。

`collect_sticker` 保持 always-on，因为收到图片后收藏属于直接聊天动作，不值得额外增加一次 capability 激活轮次。删除重复的 `media_library` capability。图片生成和外部图片抓取仍保持 deferred。

system prompt 的按需披露索引同步改为：浏览器、金融、外部研究、图片生成和图片抓取先通过 `toolbox` 激活；表情包收藏直接调用 `collect_sticker`。同时合并重复的 `workspace_bash` 和 `memory` 条目。

## 数据流

1. NapCat 媒体 segment 在入库时获得 `referenceId`。
2. `inbox` 查询保留原始 `content`。
3. `inbox` 从媒体 segment 中提取合法引用，返回 `media: [{ type, mediaId }]`。
4. Luna 将 `mediaId` 直接传给 `collect_sticker image={mediaId}`。
5. 收藏结果返回的 `mediaRef=media:<id>` 可继续传给 `send_message`。

## 边界与错误处理

- 只接受可安全转换为正整数的 `referenceId`。
- 不从图片描述、`resolvedText` 或数据库 side table 推断 handle。
- 不改变已经冻结的 `resolvedText`，避免破坏 replay 和 prompt 字节稳定性。
- 不扩大 `inbox` 的来源权限、行数上限或字符上限。

## 验证

- focused test 验证图片消息返回结构化 `mediaId`，无媒体消息返回空数组，无效引用被忽略。
- 工具 manifest 测试验证 `collect_sticker` 常驻且不再出现在 deferred capability 中。
- prompt 测试只验证能力入口语义，不锁定完整 prompt 字节。
- 最终运行 focused tests、`pnpm typecheck` 和 `pnpm repo-check`。
