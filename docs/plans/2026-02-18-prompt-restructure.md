# Prompt Restructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 调整 `generateReply` 的 prompt 格式，让触发消息成为 LLM 的首要关注点，历史记录降级为背景参考。

**Architecture:** 只改 `gemini-adapter.ts` 的 `generateReply` 方法：触发消息前置 + 加标签分隔两块内容 + 系统提示词末尾追加优先级指令。LLM 自身的 chain-of-thought 负责判断历史是否相关，无需额外调用。

**Tech Stack:** TypeScript, Gemini 2.5 Flash (`generateContent` API)

---

### Task 1: 修改 `generateReply` 的 prompt 结构

**Files:**
- Modify: `src/llm/gemini-adapter.ts`（`generateReply` 方法，当前约第 60-75 行）

**Step 1: 读当前实现，确认行号**

打开 `src/llm/gemini-adapter.ts`，找到 `generateReply` 方法，当前实现如下：

```ts
async generateReply(systemPrompt: string, context: string, trigger: string): Promise<string> {
    const response = await this.server.generateContent({
        model: MODEL,
        contents: [{
            role: 'user',
            parts: [{ text: `${context}\n\n---\n${trigger}` }],
        }],
        config: {
            systemInstruction: systemPrompt,
            temperature: 0.8,
        },
    })
    return this.extractText(response).trim()
}
```

**Step 2: 替换为新实现**

用以下代码完整替换 `generateReply` 方法体：

```ts
async generateReply(systemPrompt: string, context: string, trigger: string): Promise<string> {
    const userMessage = [
        '[用户对你说]',
        trigger,
        '',
        '[群聊背景记录（仅供参考）]',
        context || '（无）',
    ].join('\n')

    const fullSystemPrompt =
        systemPrompt +
        '\n\n---\n你的首要任务是回复"[用户对你说]"部分的内容。' +
        '"群聊背景记录"仅供参考，请根据相关性自行判断是否使用，不要主动评论历史内容本身。'

    const response = await this.server.generateContent({
        model: MODEL,
        contents: [{
            role: 'user',
            parts: [{ text: userMessage }],
        }],
        config: {
            systemInstruction: fullSystemPrompt,
            temperature: 0.8,
        },
    })
    return this.extractText(response).trim()
}
```

**Step 3: 验证编译**

```bash
pnpm build
```

预期：无错误输出（TypeScript 编译通过）

**Step 4: Commit**

```bash
git add src/llm/gemini-adapter.ts
git commit -m "fix: restructure generateReply prompt to prioritize trigger over chat history"
```

---

## 手动验证（部署后）

1. 在监听群内 @bot 发"你好" → 应正常打招呼，不提历史内容
2. @bot 发"刚才大家在聊什么" → 应引用历史背景回答
3. @bot 在历史为空（刚启动）时 → 应正常回复，不报错
