# Phase 1.5 观察手册

Step 5 是观察期：跑 dev + 真实 @bot, 验证 P0 真完成。这步无法用单测替代, 因为要看 provider 真实返回的 `cached_tokens`。

## 1. 准备

```bash
pnpm db:generate                    # 确保 prisma client 跟 schema 对齐
pnpm dev                            # tsx watch 启动 bot
```

确认 `.env`:

- `BOT_REPLY_DRY_RUN=false`（要真实发送才能让 LLM 真请求）
- `LLM_DEFAULT_PROVIDER` 指向真支持 prompt cache 的网关
- `LLM_AGENT_MODEL` 是支持 caching 的模型 (Claude / GPT 都支持)

启动后在配置的 QQ 群里 `@bot` 至少 5 次, 每两次间隔 < 5 分钟（OpenAI/Anthropic cache TTL 5 分钟）。

## 2. 验证点 1: prefixHash 跨调用稳定

```sql
-- 同一 sceneId 的最近 10 次 LLM trace, prefix_hash 应当**保持一致**
-- (除非中间触发了一次 compaction, summary 变化会让 prefix 变一次)
SELECT
  id,
  scene_id,
  loop_index,
  prefix_hash,
  cached_tokens,
  input_tokens,
  created_at
FROM llm_traces
WHERE scene_id = 'qq_group:你的群号'
ORDER BY created_at DESC
LIMIT 20;
```

期望:

- `prefix_hash` 列在多次 @bot 之间**一直是同一个值**
- 如果中间 compaction 触发, prefix_hash 会变一次, 之后又稳定

如果 prefix_hash 每次都变 → P0 没真完成, 回头查 reply-history / context-builder 拼装顺序。

## 3. 验证点 2: cached_tokens 出现非零

这是 **P0 真验证指标**。

```sql
-- 看最近 10 次调用的 cache 命中量
SELECT
  id,
  model,
  input_tokens,
  cached_tokens,
  output_tokens,
  token_usage_state,
  created_at
FROM llm_traces
WHERE scene_id = 'qq_group:你的群号'
ORDER BY created_at DESC
LIMIT 10;
```

期望:

| 调用 | input_tokens | cached_tokens |
|---|---|---|
| 第 1 次 (cold) | ~2000 | 0 |
| 第 2 次 (5 分钟内) | ~2050 | ~1900 (≈ 第 1 次大部分) |
| 第 3 次 (5 分钟内) | ~2100 | ~2000 |
| ... | 增量 | 大头来自 cache |

如果连续多次 `cached_tokens` 都是 0 / null → 检查:

- `token_usage_state` 是不是 'unavailable'? 说明 provider 没返回 cache 字段, 换 provider/model
- `prefix_hash` 是不是在变? 在变 → 拼装顺序问题
- `input_tokens` 是不是 < 1024? OpenAI cache 有最小长度门槛

## 4. 验证点 3: bot 历史发言确实是 model role

```sql
-- 看一次 trace 的 input.history JSONB
SELECT
  id,
  jsonb_pretty(input -> 'history') AS history
FROM llm_traces
WHERE scene_id = 'qq_group:你的群号'
ORDER BY created_at DESC
LIMIT 1;
```

期望 history 数组里有真 `model` role 项 (不是 `[BOT] xxx` 文本进 user role):

```json
[
  { "role": "user", "content": "用户A: 早" },
  { "role": "model", "content": "早。今天聊点啥" },
  ...
]
```

如果 bot 历史还是 `[BOT] xxx` 文本进 user → context-builder 的 renderWindowAsMessages 没接上, 排查 reply-generator 调用是不是用了 contextResult.history。

## 5. 触发 compaction (Step 7 验证用)

Step 7 完成后, 让群里产生 80+ 条新消息（或临时把 `COMPACTION_TRIGGER_USER_MESSAGES` 调小）。再:

```sql
SELECT
  group_id,
  sender_thread_key,
  compacted_version,
  length(compacted_base) AS summary_len,
  compacted_base
FROM conversation_states
WHERE group_id = 你的群号
ORDER BY updated_at DESC;
```

期望:

- `compacted_base` 是一段连贯的中文摘要 (LLM 输出)
- 不是简单 `[12:30] 用户A: ...` 那种时间戳 + 原文拼接

之后再 @bot 一次:

- `prefix_hash` 应当**变一次** (新 summary)
- 之后再 @bot, prefix_hash 又稳定下来 (新前缀)
- `cached_tokens` 仍能命中

## 6. 排查 cheatsheet

| 现象 | 可能原因 | 排查文件 |
|---|---|---|
| prefix_hash 每次都变 | history 拼装不稳定; quoted message 顺序不一致 | `src/responder/context-builder.ts` `buildContext` 末尾 |
| cached_tokens 始终为 0 | input < 1024 token; 或 provider 不支持 | 模型/网关配置 |
| token_usage_state = 'unknown' | provider 没返回 usage | 看 provider 响应原文 |
| token_usage_state = 'unavailable' | provider 返回 usage 但没 cache 字段 | 检查 model 是否支持 cache |
| bot 历史还是 `[BOT]` 文本 | reply-generator 没切到 contextResult.history | `src/responder/reply-generator.ts` |
| compactedBase 还是文本拼接 | 还没跑 Step 7, 或者 summarizer 没接上 | `src/conversation/compaction.ts` |
