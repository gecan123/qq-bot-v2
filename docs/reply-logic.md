# @-mention 回复逻辑

## 重构前 vs 现在

| | 重构前（单轮） | 现在（可路由） |
|---|---|---|
| 触发条件 | 消息含 @Bot | 同 |
| 上下文来源 | 最近 N 条消息 | 同，另加引用消息解析 |
| 回复方式 | 单次 LLM 调用 | 单轮 **或** 多轮 agent loop |
| 工具调用 | 无 | 6 个工具（历史检索 + 网搜） |
| 兜底 | 无 | agent 失败自动降级单轮 |
| 配置 | 无 | `agent-config.json` 按群配置 |

---

## 触发与路由

```
收到消息
  └── segments 含 at(selfNumber)?
        ├── 否 → continue（不处理）
        └── 是 → agent loop
                    └── 失败(null) → 单轮回复（兜底）
```

---

## 单轮回复

```
buildContext(最近 30 条消息 + 引用消息解析)
  + triggerText（@消息的文本部分）
  → llm.generateReply(persona, context, text)
  → 发送回复
```

媒体处理：最近 5 条含图/音频的消息会等待 AI 描述生成（最多 5s），超时降级为占位符。

---

## Agent Loop

适用场景：需要检索历史、分析数据、或查询互联网时。

```
buildContext
  + triggerText
  → userMessage = "${triggerText}\n\n[群聊背景]\n${context}"

runAgentLoop(maxSteps=4, maxTimeMs=30s):

  for step in 0..3:
    adapter.chat(systemPrompt, history, tools)
      │
      ├── type=text       → 直接作为最终回答返回（implicit_text）
      ├── type=empty      → fallback
      └── type=tool_calls
            ├── final_answer(text) → 取 text（截断 500 字）→ 返回
            └── 其他工具           → executor(args)
                                       → 结果追加 history
                                       → 继续下一 step

  超出 maxSteps → aborted
  超时 30s      → fallback（Promise.race）
```

### 可用工具

| 工具 | 作用 |
|---|---|
| `search_messages` | 按关键词全文搜索历史消息 |
| `get_user_profile` | 查询某用户发言统计与画像 |
| `get_group_summary` | 群整体活跃度与话题摘要 |
| `get_recent_messages` | 拉取最近 N 条消息 |
| `final_answer` | 提交最终回答（截断至 500 字） |
| `web_search` | Tavily 网络搜索（需配置 `TAVILY_API_KEY`） |

> `web_search` 仅在 `TAVILY_API_KEY` 存在时才注入工具列表，未配置时 LLM 不可见。

---

## 兜底机制

```
agent loop 返回 null（fallback / aborted）
  → 自动降级为单轮回复
    → 单轮也失败
      → log.error，跳过本条消息（不回复）
```

---

## 回复格式

```
[reply: 原消息 ID] + [at: 发送者] + " " + 回复文本
```

---

## 配置

运行时读取项目根目录的 `agent-config.json`（首次读取后缓存）。**文件不存在时不报错**，所有群使用内置默认值。

### agent-config.json

```json
{
  "default": {
    "personaFile": "./prompts/default-persona.md",
    "replyContextMessages": 30
  },
  "groups": {
    "123456789": {
      "personaFile": "./prompts/group-123456789.md"
    }
  }
}
```

Profile 合并顺序：内置默认 → `default` → 群专属配置（后者覆盖前者）。

### Persona 文件

人格 prompt 存放在 `prompts/` 目录（与其他 prompt 文件共存），每个文件是纯文本/Markdown，支持任意长度、换行与格式。

`agent-config.json` 中通过 `personaFile` 字段引用（相对于项目根目录的路径）。也可直接用内联 `persona` 字段写短文本，两者选其一；若 `personaFile` 读取失败则自动回退到 `persona` 字段。

**相关文件：**
- `src/responder/handlers/at-mention.ts` — 主入口
- `src/responder/context-builder.ts` — 上下文构建
- `src/agent/loop.ts` — agent loop 核心
- `src/agent/tools.ts` — 工具声明与执行器
- `src/agent/heuristic.ts` — 启发式判断
- `src/config/agent-profiles.ts` — profile 加载与合并
