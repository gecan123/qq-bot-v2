# Prompt 重构待办

---

## ~~1. `generateReply` 后缀指令~~ ✅

已提取到 `prompts/reply-instruction.md`，两处适配器均改为 `loadPrompt` 加载。

---

## ~~2. `buildGroupSummaryPrompt`~~ ✅

已提取静态指令到 `prompts/memory-group-summary.md`，动态数据（`oldSummarySection`、`formattedMessages`）保留在代码插值。

---

## ~~3. `buildUserProfilePrompt` 静态指令提取~~ ✅

已提取到 `prompts/memory-user-profile.md`，JSON schema 约束暂保留在文件中。

---

## 待办：`buildUserProfilePrompt` 结构化输出改造

**位置：** `src/memory/prompts.ts` + 调用方解析逻辑

**问题：** `prompts/memory-user-profile.md` 末尾的 JSON schema 约束与 `parseUserProfileJson()` 强耦合，文件内容不能随意修改。

**方向：** 引入结构化输出（structured output / response_format）替代文本解析，从根本上解耦格式约束。
