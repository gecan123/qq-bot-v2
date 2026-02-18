# Prompt 结构调整：提升 @回复的触发消息注意力

## 问题

Bot 在收到简单 @消息（如"你好"）时，受群聊历史内容干扰，回复了与触发消息无关的历史内容，而非正常响应用户。

根本原因：`generateReply` 的用户消息格式是 `${context}\n\n---\n${trigger}`，30 条历史在信息量上远超触发消息，LLM 的注意力被历史"淹没"。

## 设计目标

- 触发消息成为 LLM 的首要关注点
- 历史记录作为可选背景，由 LLM 的 chain-of-thought 自行判断是否相关
- 改动范围最小，只动 `generateReply` 方法

## 改动方案

### 用户消息格式（`gemini-adapter.ts`）

**改前：**
```
${context}

---
${trigger}
```

**改后：**
```
[用户对你说]
${trigger}

[群聊背景记录（仅供参考）]
${context || '（无）'}
```

- 触发消息提前，明确标签区分两块内容
- context 为空时填写 `（无）`，避免 LLM 把空段落误解为遗漏内容

### 系统提示词附加（`gemini-adapter.ts`）

在 `generateReply` 调用时，把优先级指令拼接到传入的 `systemPrompt` 后面：

```
${systemPrompt}\n\n---\n你的首要任务是回复"[用户对你说]"部分的内容。"群聊背景记录"仅供参考，请根据相关性自行判断是否使用，不要主动评论历史内容本身。
```

- 用 `\n\n---\n` 分隔，防止 persona 文本和指令粘连
- 无论 `agent-config.json` 里写了什么 persona，优先级指令始终生效

## 变更文件

- `src/llm/gemini-adapter.ts` — 只改 `generateReply` 方法，约 5 行

## 验证标准

1. @bot "你好" → 正常打招呼，不提历史内容
2. @bot "刚才大家在聊什么" → 利用历史背景正确回答
3. context 为空时 → 正常运行，不报错
