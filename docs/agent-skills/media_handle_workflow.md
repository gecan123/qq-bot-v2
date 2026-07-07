---
name: media_handle_workflow
description: 处理图片 mediaId、ephemeralRef、图片生成/编辑、下载、描述、发送或收藏表情包时使用
---

# 媒体 Handle 工作流

图片在上下文里使用 handle，不直接把原始 bytes 当作事实到处复制。

常见 handle:

- 入站媒体由 `inbox` 结果里的 `media[].mediaId` 披露。
- 临时或生成媒体可能使用 `ephemeralRef`。
- 发送链路使用 `media:N` 或 `ephemeral:<64-hex>` 这类 ref。

基本流程:

1. 需要理解入站图片时，先用 `inbox` 读取对应消息，拿到 media handle。
2. 需要下载图片 URL 或 QQ 头像时，激活 `media_fetch`。
3. 需要生成或编辑图片时，激活 `media_generation`，等待后台任务完成。
4. 需要收藏表情包时，用 `collect_sticker`，不要手写文件到表情目录。
5. 需要发送图片时，必须走 `send_message`，且 target 明确。

上下文规则:

- 预览或描述可以进 context；原始图片 bytes、artifact 路径和 action log 不能成为 replay 来源。
- 图片描述失败时，降级为稳定文本结果，不要伪造看见了内容。
- 生成图片任务完成后，先确认结果里有可发送 handle，再发送或收藏。

安全边界:

- 不把敏感图片内容写入长期 memory，除非 owner 明确要求且不会伤害他人。
- 不把私聊图片转发到群里，除非目标和授权非常明确。
- 不下载或处理明显高风险文件伪装成图片的链接。
