# 清理 `send_image` 旧工具认知设计

## 背景

运行日志中出现 10 次 `send_image` 调用，全部返回 `Unknown tool: send_image`。当前工具注册表、system prompt、仓库源码、Git 历史和持久 snapshot 均不存在 `send_image` 注册；正确发送入口是 `send_message`，图片通过 `imageRef` 传入。

因此问题不是残留运行时注册，而是模型生成了不存在的旧工具名。多数失败调用的 `imageRef` 为 `null`，说明模型还会把 `send_image` 错当成普通消息发送入口。

## 目标

- 保持唯一 QQ 发送入口为 `send_message`。
- 明确文本和图片都由 `send_message` 发送。
- 明确 `send_image` 不存在，避免模型继续尝试调用。
- 用测试阻止未来重新注册 `send_image` 或弱化统一发送指引。

## 非目标

- 不注册 `send_image` 兼容 alias。
- 不在 executor 中把 `send_image` 隐式改写为 `send_message`。
- 不改写历史 snapshot；当前 snapshot 已无 `send_image`，且 replay 不应从日志重建或修改历史。
- 不清理或改写现有审计日志。

## 设计

1. 在 `send_message` 的 tool description 中补充明确约束：文本、图片、图文消息都使用本工具；不存在独立的 `send_image` 工具。
2. 在常驻 system prompt 的发送规则附近补充同一条短指引，让未激活媒体 capability 时模型也能看到正确出口。
3. 在工具注册测试中断言：
   - always-on 工具包含 `send_message`；
   - 所有 always-on 和 deferred 工具均不包含 `send_image`；
   - `send_message` 描述明确包含图片发送入口和 `send_image` 不存在的提示。
4. 在 system prompt 测试中断言统一发送指引存在，防止后续 prompt 整理时被误删。

## 数据流与错误处理

图片生成、抓取或收藏工具继续返回 `media:<id>` 或 `ephemeral:<64-hex>`。Agent 将该值传给 `send_message.imageRef`，由现有发送链路解析、发送并记录审计。若模型仍调用 `send_image`，executor 继续返回标准 `unknown_tool`，不做静默兼容，以免隐藏模型或 prompt 漂移。

## 验证

- 先增加回归断言并确认当前代码因缺少明确指引而失败。
- 修改 tool description 和 system prompt 后运行对应 focused tests。
- 运行 `pnpm repo-check`，确认 `AGENTS.md` / `CLAUDE.md`、prompt 及工具文档约束没有漂移。
- 运行 `pnpm typecheck` 做静态验证。
