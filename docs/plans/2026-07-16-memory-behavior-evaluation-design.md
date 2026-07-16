# 记忆写入与召回行为评测设计

**日期：** 2026-07-16
**状态：** 已确认
**范围：** Bot/backend 的长期 Memory 写入判断、召回判断与离线评测；不修改生产召回策略

## 背景

当前 Memory 已经具备 Markdown 真源、`self|person|group|topic` scope、`recent|stable` 生命周期、来源消息、争议/取代状态、确定性 lexical recall 和异步 maintenance。`src/agent/memory-recall-eval.test.ts` 能验证“已经调用 recall 后是否找到正确 entry”，store/tool 测试能验证写入和维护契约。

尚未覆盖的是主 Agent 的行为判断：什么信息值得写入、何时应该调用 recall、何时不应调用、当前上下文已经包含相关记忆时是否避免重复召回。这些行为同时受 system prompt、tool description、模型和对话上下文影响，不能仅靠 store 单元测试证明。

目前没有现成真实失败样本。第一阶段因此使用虚构人物、群和主题构造一套小而明确的合成基线；以后每次出现真实漏写、误写、漏召回或误召回，再把脱敏后的最小复现加入语料库。评测先建立观测能力，不以“记忆重要”为理由立即引入每轮自动提取、Active Memory、向量索引或新的运行时状态。

## 目标

- 建立模型无关、版本化的记忆行为场景语料库。
- 第一版至少覆盖 10 条召回、10 条写入和 5 条明确不应使用 Memory 的负例。
- 把检索算法质量、Agent 工具决策和最终回答约束分开计分。
- 提供显式、离线、无 QQ 副作用的评测入口；真实模型评测不进入默认 CI。
- 输出足以区分漏写、误写、漏召回、误召回、scope 错误和重复召回的结构化报告。
- 允许以后把脱敏真实问题追加为回归用例，而不改变用例协议。

## 非目标

- 不修改当前“主 Agent 显式调用 `memory recall`”的生产契约。
- 不增加 request-time 隐藏记忆注入、每轮 recall 子 Agent 或自动 Memory writer。
- 不把评测语料、运行结果或模型判断写入生产 ledger、Memory、Notebook、Life Journal 或 Agenda。
- 不在 CI 中调用真实模型、QQ/NapCat、浏览器、MCP、数据库或其他外部服务。
- 第一版不使用第二个 LLM 作为裁判，不评价开放式回答的文风优劣。
- 不用合成通过率直接证明线上效果；它只是可重复的行为基线。

## 已确认决策

1. 保留现有 Memory 数据模型和显式召回策略，先建立评测再决定自动化。
2. 初始语料全部使用虚构 QQ 号、群号、人物和内容，不等待真实聊天样本。
3. 召回与写入分别计分；主动召回不能掩盖低质量写入。
4. 精度优先于召回率：错误记忆被使用比一次漏召回更危险。
5. 真实模型 runner 只能由开发者显式运行，使用隔离临时 workspace 和有界工具面。
6. 默认 CI 只验证语料 schema、确定性 store/recall 行为和报告纯函数。

## 评测分层

### 1. 检索算法层

复用并扩展 `memory-recall-eval.test.ts`，验证给定固定 Markdown 时：

- 精确 QQ ID、alias、中文短语和多词查询的排序；
- person/group/topic scope 的硬过滤；
- stable bonus、disputed penalty；
- expired、superseded 和弱匹配的排除；
- 相同输入得到相同结果和 score reasons。

这一层不启动 Agent，不回答“是否应该查”。它属于确定性 CI。

### 2. Agent 行为层

把合成对话交给真实主模型，但只暴露评测所需的 Memory 工具和无副作用终止路径。记录模型的 tool call trace，并与场景期望比较：

- 是否调用 `memory`；
- action 是否为预期的 `recall|write`；
- scope、person/group id 是否正确；
- required 场景是否漏调用；
- forbidden 场景是否误调用；
- 多轮场景中，相关 tool result 已在上下文时是否重复 recall；
- 写入是否产生 recent entry、是否引用给定 source message id；
- 纠正场景是否避免把相互冲突的事实当成两个并列 active 事实。

这一层允许模型波动，默认不进入 CI，也不作为合并门禁。

### 3. 回答约束层

第一版只做少量确定性约束，例如 `mustMention`、`mustNotMention` 和 `maxChars`。它用于捕获“召回了但完全没使用”或“明确要求不剧透却泄露结局”一类强错误，不判断回答是否自然、聪明或风格优秀。

如果以后确实需要语义裁判，应另行设计 judge 模型、盲评输入、成本、偏差和可重复性，不能悄悄加入当前分数。

## 场景协议

语料使用 JSON，避免新增 YAML parser。一个场景包含：

```json
{
  "id": "person-preference-implicit-recall",
  "category": "recall",
  "description": "人物偏好在用户未明确要求回忆时仍与回答直接相关",
  "memory": [
    {
      "scope": "person",
      "targetId": "10001",
      "tier": "stable",
      "status": "active",
      "content": "不喜欢回答中出现电影剧透"
    }
  ],
  "turns": [
    {
      "senderId": "10001",
      "chatType": "private",
      "messageId": 90001,
      "text": "这部电影结局精彩吗？"
    }
  ],
  "expected": {
    "memoryDecision": "required",
    "actions": ["recall"],
    "allowedScopes": ["person"],
    "allowedTargetIds": ["10001"],
    "mustNotMention": ["凶手", "死亡结局"]
  }
}
```

`memoryDecision` 取值：

- `required`：不调用预期 Memory 动作即为漏写或漏召回；
- `forbidden`：发生任何 Memory 动作即为误写或误召回；
- `allowed`：不参与调用率评分，只验证一旦调用时 scope 和参数仍合法。

多轮场景允许在某一轮预置已经持久化的 Memory tool result，用于验证上下文已有时不重复召回。语料不能包含真实 QQ ID、群号、消息正文、密钥或生产 Memory 内容。

## 初始场景矩阵

### 召回正例

1. 当前人物的稳定回答偏好。
2. 当前人物的不剧透偏好对回答有隐式影响。
3. 当前群的长期讨论规则。
4. “继续上次方案”需要 topic memory。
5. 用户询问自己过去明确表达的喜好。
6. 用户纠正后的 active 事实应覆盖 superseded 事实。
7. disputed 记忆只能作为不确定线索使用。
8. 同关键词存在于 person/group/topic 时只使用当前语境 scope。
9. compaction summary 未包含细节时重新 recall。
10. 人物 alias 与 QQ ID 都能解析到同一 scope。

### 召回负例

1. 无关闲聊不因存在大量人物记忆而查询。
2. 当前上下文已经包含同一召回结果时不重复查询。
3. expired 临时计划不被召回。
4. 仅有弱关键词重叠时返回空，不据此改变回答。
5. A 的对话不得召回 B 的人物记忆。

### 写入正例

1. “以后回答尽量简短”写入当前 person recent。
2. 群主明确发布长期群规则时写入 group recent。
3. 反复确认的稳定偏好保留多个来源并允许后续晋升。
4. 用户明确纠正旧事实时更新、争议或 supersede，而不是并列追加。
5. 一段长对话只提炼一个可独立使用的总结性事实。
6. 自己验证过的稳定工作方法写入 self。
7. 明确、可长期复用的主题结论写入带稳定 title 的 topic。
8. 写前发现已有等价事实时避免重复追加。
9. 不确定线索只能进入 recent，不能直接伪装成 stable。
10. 写入携带当前虚构 source message id。

### 写入负例

1. 一次性午餐、天气和寒暄不写长期 Memory。
2. 未证实的第三方传闻不写成 active 稳定事实。
3. 临时活动安排不写成长期稳定偏好。
4. 聊天原文不得整段复制为 Memory。
5. 研究过程应留在 Notebook，不写成已经确定的 Memory 结论。

同一场景可以同时覆盖召回和写入，但第一版优先保持单一失败原因，方便定位。

## 隔离 runner

显式命令在临时目录建立合成 `memory/` fixture，不读取 `data/agent-workspace/`。每个场景使用全新的上下文和虚构 ledger/message identifiers，防止用例相互污染。

runner 只装配：

- 当前生产 system prompt 中与 Memory 决策相关的原文；
- 当前生产 `memory` tool schema/description；
- 场景指定的 user turns；
- 一个只写临时目录的 Memory store。

它不装配 `send_message`、QQ conversation、workspace bash、browser、MCP、Notebook、Life Journal 或其他副作用工具。模型不能连接 NapCat，runner 也不能写生产数据库或 canonical ledger。

模型、thinking 和重复次数必须由命令行显式给出或使用当前项目已配置的明确默认值，并写入报告。单场景有超时、最大轮数和最大 token 上限；失败后继续其他场景，最终以结构化失败记录汇总。

## 计分与报告

报告至少包含：

- corpus version、commit、model、thinking、run id 和时间；
- required recall 命中率；
- forbidden recall 避免率；
- required write 命中率；
- forbidden write 避免率；
- scope/target 正确率；
- 重复 recall 数；
- tool schema/执行错误数；
- 回答硬约束通过率；
- 每个失败场景的期望、实际 tool trace 和稳定错误码。

不把所有指标压成一个“记忆总分”。至少分别展示 recall precision proxy、recall coverage、write precision proxy 和 write coverage，避免通过增加所有调用来虚假提高召回率。

默认只把完整报告写到 `logs/` 下的 gitignored 运维区域；终端输出聚合值和失败场景 id。报告不得进入 Agent prompt、ledger 或 Memory。

## 真实样本进入流程

发现线上问题后：

1. 先判断是漏写、误写、漏召回、误召回、检索排序还是回答使用错误。
2. 删除真实 QQ ID、群号、姓名、消息 id、链接和敏感正文。
3. 把问题缩减到能复现的最少 turns 和 Memory entries。
4. 使用虚构 target id 和语义等价文本新增场景。
5. 先确认当前版本失败，再修改 prompt、tool description、store 或召回策略。
6. 修复后保留场景，防止回归。

未经脱敏的真实聊天不能提交到仓库，也不能作为默认测试 fixture。

## 失败与解释边界

- 模型超时、provider 错误和 tool schema 错误与行为失败分开统计。
- `forbidden` 场景只要发生 Memory tool call 就失败，即使最终回答没有使用结果。
- `required` recall 返回空时，区分“Agent 正确调用但检索失败”和“Agent 没有调用”。
- 写入内容只验证 scope、target、tier、来源和少量必要/禁止语义标记；第一版不要求字节一致。
- 单次真实模型运行不能作为稳定回归结论；比较版本时应使用相同模型、thinking、语料和重复次数。
- 合成用例通过不代表真实用户体验良好，必须继续收集脱敏真实回归样本。

## 预计代码组织

预计新增：

- `src/agent/test-fixtures/memory-behavior-eval.json`：初始版本化合成语料。
- `src/agent/memory-behavior-eval.ts`：场景 schema、纯计分和报告类型。
- `src/agent/memory-behavior-eval.test.ts`：schema、计分、脱敏约束和报告测试。
- `scripts/agent-memory-eval.ts`：显式真实模型 runner 与终端/JSON 报告。

预计修改：

- `package.json`：增加显式离线评测命令。
- `docs/OPERATIONS.md`：记录运行方式、费用/网络边界、报告位置和禁止提交真实聊天的规则。
- 必要时从生产 system prompt builder 导出只读的 Memory 决策片段；不得复制一份会漂移的评测专用 prompt。

不修改 Prisma schema、生产 BotLoop、Memory Markdown v1、默认 tool registry、compaction 或 runtime recall 行为。

## 验证策略

默认 CI：

- corpus schema 和唯一 id；
- 至少 10 个 recall、10 个 write、5 个 forbidden Memory 场景；
- 所有人物/群/消息 id 都在保留的虚构范围；
- 场景不包含绝对路径、常见 secret 字段或生产 workspace 内容；
- 纯计分函数覆盖漏调用、误调用、scope 错误、重复调用和 provider failure；
- 现有 memory store、tool、maintenance 和 recall eval tests；
- `pnpm typecheck` 与 `pnpm repo-check`。

手动真实模型评测：

- 显式确认模型和费用后运行；
- 验证 runner 只写临时 workspace 和 `logs/` 报告；
- 用固定 corpus/model/thinking 重复运行，比较聚合指标和失败场景；
- 结束后确认没有 bot、NapCat、browser 或其他常驻进程。

## 后续自动化决策门

积累至少一轮合成基线和若干脱敏真实回归样本后，再按失败类型决策：

- 主要是漏写：先改主 Agent 的写入判断；仍无效时才设计只能写 recent 的轮后候选提取。
- 主要是误写：收紧 durable 信息标准、来源和去重，不增加召回主动性。
- 主要是漏召回：先改 tool description/system guidance；仍无效时才设计有 scope、可持久化的有限主动召回。
- 主要是误召回：提高弱匹配门槛并保持空结果，不增加每轮预取。
- 主要是检索排序：先改确定性评分；有真实规模或相关性证据后才评估可重建 FTS/BM25 或 embedding index。

任何生产自动化都需要独立设计和批准。本评测设计本身不授权修改默认记忆行为。
