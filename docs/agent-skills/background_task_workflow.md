---
name: background_task_workflow
description: 异步工具返回 taskId、收到后台任务完成事件或需要安排非空转轮询时使用；普通同步工具已经直接返回结果时不要使用。
---

# 后台任务工作流

后台任务用于耗时或异步工作，例如图片生成、长抓取、批量处理和未来的外部集成。不要把它当作普通同步工具结果。

基本流程:

1. 工具返回 `taskId` 后，先记住任务目的和下一步要查什么。
2. 用 `background_task action=list` 看当前任务摘要；需要正文结果时再 `action=get`。
3. 如果任务还没完成，用 `pause action=rest` 安排一个明确的 `intention`，醒来后继续查这个 `taskId`。
4. 收到后台任务完成事件后，用 `background_task action=get` 读取有界结果，再决定是否发送、收藏、继续处理或休息。

边界:

- 不要凭旧状态假设任务已完成。
- 不要为了轮询而连续空转；用 `pause` 让循环休息。
- 任务结果进入上下文的是有界 tool result，不要从磁盘 artifact 或日志重建 prompt history。
- 任务失败时先读结构化错误，再决定重试、换方案或请求 owner help。

发送或后续处理:

- 生成图片要先拿到可用 image handle，再决定 `send_message` 或 `collect_sticker`。
- 长文本结果先摘要，再发给人；不要把完整大块内容塞进常驻上下文。
- 有副作用的下一步仍按对应工具边界执行，后台任务完成不代表自动批准发送或写入。
