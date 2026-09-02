# 长时间自主 Agent 的上下文退化、机械循环与创新枯竭

日期：2026-08-31

## 研究问题与方法

本文研究的不是模型是否真的产生了人类意义上的焦虑，而是一个可观测的工程问题：模型在长上下文、长时间自主运行后，会不会出现提前收尾、自我诊断、重复工具调用、反复改写笔记、创新幅度缩小和敷衍完成等行为；已有系统如何缓解这些问题。

只采用论文、作者项目页、官方工程文章、官方文档和官方源码。下文明确区分：

- **来源结果**：来源直接报告的实验、实现或经验。
- **对本项目的推断**：把来源与 qq-bot-v2 当前代码契约结合后的工程判断，不代表论文作者的原话。

## 结论先行

1. **“时间流逝”本身不是已证实的原因。** 更可信的解释是：有效注意力被增长的历史、重复观察和自我叙事稀释；多轮早期假设产生路径依赖；模型感知到剩余上下文后开始提前收尾。Anthropic 已把最后一种现象直接称为 `context anxiety`，但这是工程行为标签，不是心理诊断。
2. **扩大上下文窗口或只做摘要都不够。** 长上下文研究反复发现，输入增长本身会降低可靠性；关键事实位于中间时尤其容易丢失。Anthropic 在长时间应用开发中进一步报告：对 Sonnet 4.5，compaction 保持了连续性，却没有提供阻断旧行为模式所需的“干净起点”。
3. **应保留永续自主性，但把每次激活限制为有边界的 episode。** 永续的是目标、事实账本和事件唤醒，不应是同一个不断膨胀的工作上下文。episode 失败后自动换方向；方向耗尽后等待真实事件，而不是继续生成“我卡住了”的文字。
4. **进展必须由外部可验证状态定义。** 新证据、成功测试、创建或修改的产物、真实环境状态变化可以算进展；重复读取、空 recall、自我总结、重复发“没有方向”、open/close 抖动不能算进展。
5. **reflection 只有在接入外部反馈时比较可靠。** Reflexion 的收益来自环境反馈、测试或评分器；多项研究显示，无外部反馈的自我反省可能无效、放大错误或在部分任务上降低性能。应限制为一次失败后的一次证据驱动反思，而不是每轮反省。
6. **开放式创造需要 curriculum 和换方向规则。** Voyager 不是让模型无限自由联想，而是生成可学习的新任务、执行、验证；连续失败后换任务，只把验证成功的技能写入库。开放式进化研究也显示：零记忆会重复，过多记忆又会压缩探索空间；小而相关的工作记忆更合适。
7. **仅放宽休息额度大概率只是延迟复发。** 休息适合冷却和等待；它不会纠正错误的进展判定，也不会清除已形成的上下文吸引子。更有效的是事件驱动休眠、硬 episode 边界、上下文重置和结构化 handoff。

## 1. “焦虑”现象：来源真正证明了什么

### 1.1 官方资料确实观察到 `context anxiety`

**来源结果。** Anthropic 的[长时间应用开发 harness 文章](https://www.anthropic.com/engineering/harness-design-long-running-apps)报告，模型在感知到上下文窗口即将耗尽时，会过早收尾，作者将其称为 `context anxiety`。他们发现：

- 单纯 compaction 能保留连续性，但在 Sonnet 4.5 的测试中不足以阻断旧行为模式；
- “干净上下文重置 + 结构化 handoff”同时缓解了上下文连贯性下降和提前收尾；
- 把 generator 与持怀疑态度的 evaluator 分开，比要求 generator 自己可靠地批评自己的结果更有效；
- 对主观工作先定义可评分标准，分数无趋势时 pivot，而不是继续同一路线。

这是与截图中“运行了 20 小时”“预算耗尽”“无法从内部打破循环”等措辞最直接的一手来源。但文章描述的是行为模式，不证明模型拥有主观焦虑。

### 1.2 长度、位置和多轮路径依赖都会降低可靠性

**来源结果。** [Lost in the Middle](https://arxiv.org/abs/2307.03172)发现，模型利用长上下文中的信息呈 U 形：开头和结尾的信息表现较好，相关信息位于中间时明显变差；即便明确支持长上下文的模型也存在这一问题。

Chroma 的[技术报告](https://www.trychroma.com/research/context-rot)与[复现实验仓库](https://github.com/chroma-core/context-rot)控制任务复杂度、只增加输入长度，在多个模型上观察到一致退化；其中 LongMemEval 的 focused context 比完整超长历史表现更好。它是公司技术报告而非同行评审论文，证据强度低于正式论文，但实验和代码公开，方向与其他来源一致。

[LLMs Get Lost In Multi-Turn Conversation](https://arxiv.org/abs/2505.06120)在大规模模拟多轮对话中报告显著性能下降：主要问题不是能力上限完全消失，而是可靠性下降；模型早期形成假设或过早给出答案后，之后会依赖它且难以恢复。

Anthropic 的[上下文工程指南](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)把这一类现象称为 `context rot`：上下文是有限注意力预算，应尽量保持高信号、低冗余，而不是把所有历史永久铺在工作区。

**对本项目的推断。** 截图里的时间表达更像上下文中持续存在的计时锚点，被每次重放后反复用来解释失败。删除计时信息可能减少表面焦虑叙事，但根因仍是“长历史 + 路径依赖 + 错误进展信号”；不能只改措辞。

## 2. 上下文压缩、干净重置和分层记忆

### 2.1 不要在“完整历史”和“失忆”之间二选一

**来源结果。** Anthropic 的[上下文工程指南](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)建议结合：

- compaction：保留架构决策、未解决问题和必要事实，删除重复工具输出；
- structured note-taking：把可复用信息写到上下文外，需要时再取；
- sub-agent 或独立上下文：让不同任务拥有隔离的注意力预算。

它也警告过度压缩会丢失细节。OpenAI 的[长运行模型指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)同样建议在自然里程碑处 compaction，并监测上下文用量；其[Responses compact API](https://developers.openai.com/api/reference/java/resources/responses/methods/compact)把压缩结果作为后续请求的 opaque item 使用。这些是厂商工程建议，不是对所有 Agent 的统一效果保证。

**来源结果。** [HiAgent](https://arxiv.org/abs/2408.09559)按 subgoal 分块：当前 subgoal 保留详细 action-observation，已完成 subgoal 只保留摘要；论文在五个长程任务上报告成功率提升和平均步骤下降。[MemGPT](https://arxiv.org/abs/2310.08560)则把有限工作上下文与外部存储分层管理，说明“持久保存所有事实”不等于“每轮把所有事实全部放进 prompt”。[MemoryBank](https://arxiv.org/abs/2305.10250)探索时间和重要性驱动的遗忘/强化，但证据主要来自模拟陪伴场景，适合借鉴“可衰减、可再强化”，不宜照搬其具体记忆公式。

### 2.2 反复整体重写会造成另一种塌缩

**来源结果。** [Agentic Context Engineering（ACE）](https://arxiv.org/abs/2510.04618)把迭代中反复整体改写上下文称为 context collapse：有用细节可能在一次次压缩中被删除或概括成空洞短句。论文改用 Generator、Reflector、Curator 分工，提交结构化增量 delta，再确定性合并。其消融实验展示了 monolithic rewrite 的长度和准确率同时骤降，并报告 ACE 在两个评测域中优于基线；但它也是预印本，且作者明确承认反馈不可靠时，增量上下文同样会被污染。

**对本项目的推断。** qq-bot-v2 可以同时满足两个契约：

- `bot_agent_ledger_entries` 继续作为 append-only 的唯一持久 LLM history source；
- 每个自主 episode 使用新的 working projection，只接收结构化 handoff 和按需取回的证据。

所谓“干净重置”不要求删除 ledger，也不应破坏确定性 replay；它是添加一个可重放的 episode/compaction boundary，让 projection 不再携带上一 episode 的冗余工具输出和自我叙事。

## 3. Reflection：何时有效，何时会自我强化

### 3.1 有外部反馈的反思可以提高表现

**来源结果。** [Reflexion](https://papers.neurips.cc/paper_files/paper/2023/file/1b44b878bb782e6954cd888628510e90-Paper-Conference.pdf)不是让模型自由反刍；它从环境奖励、测试或语言反馈中生成简短反思，写入 episodic memory 后再尝试。论文在多个任务上报告提升，包括 HumanEval 上 91% pass@1（论文对比的 GPT-4 baseline 为 80%）。[CRITIC](https://arxiv.org/abs/2305.11738)也通过搜索、代码执行等外部工具交叉检查和修订输出，在多类任务上获得改进。

### 3.2 无外部反馈的自我修正并不可靠

**来源结果。** [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798)发现，缺乏外部反馈时的 intrinsic self-correction 常常失败，有时反而降低性能。[When Hindsight is Not 20/20](https://aclanthology.org/2024.findings-naacl.237/)进一步发现，无外部反馈的 hindsight 在 TruthfulQA 上有收益，却损害 HotpotQA；效果依赖初始正确率和任务难度。[ReflecTool-Bench](https://aclanthology.org/2026.findings-acl.86/)显示模型更容易发现用户造成的错误，对自身造成的错误更弱，从 critique 到 self-reflection 时表现明显下降。[Degeneration of Thought](https://arxiv.org/abs/2305.19118)发现，一旦模型对初始立场形成高置信度，后续 reflection 可能无法产生真正的新思路。

**对本项目的推断。** “我已经运行 20 小时—我陷入机械循环—我需要外部干预”如果没有新的环境证据，只是把同一判断重新写入上下文；它不应成为 Memory 的稳定事实，也不应触发下一轮。反思应满足：

1. 前一行动产生了可检查的失败结果；
2. 最多生成一次短 delta：失败假设、证据引用、下一方向；
3. 只有被后续外部结果支持的 delta 才进入长期 Memory；
4. 同一失败签名再次出现时直接换方向，不再反思同一问题。

## 4. 长期开放式创造：自由不是无界重复

### 4.1 自动课程、验证和失败换题

**来源结果。** [Voyager](https://arxiv.org/abs/2305.16291)的开放式 Minecraft Agent 由 automatic curriculum 选择新任务，通过环境反馈、执行错误和 self-verification 判断结果，并只把验证成功的技能加入 skill library。官方实现描述中，某任务连续多次生成代码仍失败后，会回到 curriculum 获取另一个任务，而不是无限修补同一路径。它报告了更广探索、更快技术树里程碑和更多独特物品。

[OMNI](https://arxiv.org/abs/2306.01711)指出，开放式任务选择既要可学习，又要有趣；只追逐学习进展会被容易变化但无意义的任务吸走。[LLM Agents Beyond Utility](https://arxiv.org/abs/2510.14548)则提供负面证据：只有自生成任务和记忆，并不能保证真正开放式行为；Agent 仍可能高度依赖 prompt、重复且缺少稳定自我表示。

### 4.2 创造力也需要“小而不同”的记忆

**来源结果。** Sakana AI 的[Picbreeder-VLM 项目页](https://pub.sakana.ai/picbreeder-vlm/)和[论文](https://arxiv.org/abs/2605.23908)观察到 VLM 容易落入 attractor：反复选择同类 parent，语义跳跃越来越小。零记忆会反复生成相同内容；加入少量上一代信息能打破重复；但给太多历史又会过载，并产生抽象、重复、简单化的结果。适量随机性可以跳出 basin，但过多会制造低质量“噪声创意”；不同 persona 能提升语义覆盖和演化树平衡。该研究来自特定图像进化设置，不能直接等同于 QQ Agent，但对“记忆越多越创新”的反例很有价值。

**对本项目的推断。** 自主创造应维护一个小型 curriculum，而不是一句永久的“找有价值的事”：

- 候选方向需要同时满足：可执行、可验证、与最近成功/失败方向有语义差异；
- 每个方向最多尝试固定轮数；失败签名重复后降低其近期权重；
- 每次 episode 只推进一个方向；成功后保存产物和证据，而不是保存完整思考过程；
- 可引入少量探索噪声或不同评审视角，但不能把随机调用工具本身当创造。

## 5. 机械循环、休眠和预算

### 5.1 工程系统普遍同时使用步数上限和事件暂停

**来源结果。** OpenAI Agents SDK 的[Agent 配置文档](https://openai.github.io/openai-agents-python/agents/)明确说明：持续强制 `tool_choice` 会造成无限工具循环，因此 SDK 默认在一次工具调用后重置为 `auto`；[运行文档](https://openai.github.io/openai-agents-python/running_agents/)提供 `max_turns` 和暂停/恢复机制。LangGraph 的[interrupt 文档](https://docs.langchain.com/oss/python/langgraph/interrupts)把状态持久化后无限期等待，直到收到 resume；其[`GRAPH_RECURSION_LIMIT` 文档](https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT)也要求循环具有停止条件和上限。

[Magentic-One](https://www.microsoft.com/en-us/research/wp-content/uploads/2024/11/MagenticOne.pdf)维护 Progress Ledger 和 stall counter；检测到多轮无进展后离开当前内循环并重新规划，同时受最大尝试次数和时间限制。VisualWebArena 的[官方 runner 源码](https://github.com/web-arena-x/visualwebarena/blob/main/run.py)包含最大步骤、重复等价动作和连续解析失败等 early-stop guard。这些是可复用的工程模式，不证明某一阈值适用于 qq-bot-v2。

### 5.2 外部最终状态比模型自报完成更可靠

**来源结果。** [τ-bench](https://arxiv.org/abs/2406.12045)不相信模型说“完成了”，而是检查数据库最终状态是否满足 annotated goal；论文还用 `pass^k` 衡量重复执行的一致性，显示强模型的可靠性仍然有限。[PushBench](https://arxiv.org/abs/2605.23574)专门评测长时间自主 Agent 的重复工作、错误完成和进度漂移，并使用 verifier-backed work unit；它是很新的预印本，数字需谨慎看待，但评测对象与本问题高度贴近。

**对本项目的推断。** 永续生命周期和无界单次运行应分开：

- **生命周期**可以永久：ledger、schedule、事件源和未完成方向都保留。
- **一次激活**必须有界：固定工具轮数、无进展阈值、单一方向和上下文预算。
- episode 成功、失败或预算耗尽后持久化结构化状态并 `wait_event`；下一事件到来时用干净 working context 恢复。

因此，放宽 `rest` 额度只能让模型多调用几次休息，不能解决“休息后仍加载相同历史、仍把重复行为算进展”的根因。更合理的是预算耗尽后不再让 LLM 周期性解释自己的处境，而是 runtime 直接等待外部事件或明确的下一次 schedule。

## 6. 对 qq-bot-v2 当前实现的最小落地方案

以下均为**基于当前代码的项目推断**，不是来源原话。

### 6.1 第一优先级：修正 `progress` 语义

当前已有的 no-progress 机制并非不存在，而是容易被假进展绕过：

- [`react-kernel.ts`](../../src/agent/react-kernel.ts) 第 243–249 行把未声明 `outcome.progress` 的成功工具结果默认成 `true`。
- [`send-message.ts`](../../src/agent/tools/send-message.ts) 第 400–404 行发送成功只返回 `{ ok: true }`，因此任意成功外发都会被默认计作进展。
- [`notebook.ts`](../../src/agent/tools/notebook.ts) 第 131–158 行的 `list/search/read` 没有显式 outcome，也会被默认计作进展；`write/update` 则无条件 `progress: true`，即使内容只是重复自述。
- [`conversation.ts`](../../src/agent/tools/conversation.ts) 第 124–140 行已经正确地只在 focus 改变时算进展，但 open/close 交替仍能不断制造状态变化。
- [`loop-policy.ts`](../../src/agent/loop-policy.ts) 第 90–112 行已有“连续无进展后 `wait_event`”逻辑；只要上游 `madeToolProgress` 被错误置真，它就永远看不到停滞。

最小修改原则：把默认值改为 `progress: false`，要求每个会产生真实外部 delta 的工具显式声明进展。建议定义窄而可测试的判定：

```text
progress = 新证据行 / 新或变化的产物 / 成功验证 / 目标外部状态变化
```

以下不算进展：相同输入的重复 read/search/list、空 recall、仅 open/close、rest、schedule 已存在、自我总结、重复或无必要的外发消息。成功发出用户请求的答复可以结束当前方向，但不应自动要求继续自主循环。

### 6.2 保留现有 LoopPolicy，补一个 episode boundary

[`bot-loop-agent.ts`](../../src/agent/bot-loop-agent.ts) 第 205–229 行已经轮换自主探索方向，并明确要求两轮无进展后重新等待。这与研究共识相符，应优先修复进展信号，而不是新建另一个复杂调度系统。

在此基础上增加最小 episode 状态：

```ts
type AutonomyEpisode = {
  id: string
  direction: string
  startedAt: string
  remainingRounds: number
  evidenceRefs: string[]
  artifactRefs: string[]
  failedSignatures: string[]
}
```

episode 结束条件：获得一个 verifier-confirmed delta、连续两轮无进展、同一失败签名重复、或轮数/上下文预算耗尽。结束时只追加结构化 handoff：当前方向、证据引用、产物引用、明确 blocker、尚未尝试的下一个方向。不要把“运行多久”“我很焦虑”“我陷入循环”的逐轮自述带入下一 working context。

### 6.3 干净上下文重置，不删除 canonical ledger

在自然边界追加一个可重放 boundary entry，下一 episode 的 projection 仅包含：

1. 稳定 system contract；
2. 最近真实用户输入或唤醒事件；
3. 上一 episode 的结构化 handoff；
4. 当前方向需要的少量证据；
5. 按需读取旧 ledger/Notebook/Memory 的引用。

完整 ledger 仍保留且 replay 确定；只是旧 raw tool outputs、重复自我反思和已关闭方向不再占用新的注意力预算。先用现有 compaction seam 实现，不额外建设第二套 history。

### 6.4 把反思、外发和换方向变成硬约束

- 只有真实失败结果到达后允许一次 reflection；其输出必须引用失败证据并提出不同的下一行动。
- 同一 `failedSignature` 第二次出现，runtime 直接切换下一个 curriculum direction，不再让模型解释。
- 无待回复用户、无新证据时，“我卡住了/需要外部干预/我会停止骚扰”类外发不允许计进展，并在短窗口内做语义去重。
- evaluator 与 generator 逻辑分离，但个人实验项目不需要先建常驻第二 Agent：可在 episode 结束时用一次无工具、只读候选产物和明确 rubric 的 evaluator call；最终真值仍由测试、文件、DB 或外部状态决定。
- 所有方向耗尽后由 runtime `wait_event`。下一真实消息、schedule 或新的环境变化再开启新 episode；不要用短周期 LLM wake 重复确认“仍然没有方向”。

## 7. 最小验证方案与指标

先做一个复现截图行为的回归，再改实现。构造逐渐增长的 ledger：真实任务已完成，随后注入重复 notebook read/write、空 recall、rest budget exhausted、conversation close/open 和三段近义“无方向”消息。

应断言：

1. 未显式声明 external delta 的工具结果是 `progress=false`。
2. 空 recall、重复 notebook 读取、重复 schedule、无变化的 focus 都不重置 no-progress counter。
3. 连续两轮无进展后结束 episode 并 `wait_event`，不会再次主动发近义求救消息。
4. 同一失败签名重复后选择不同 direction；所有方向尝试完才等待。
5. 新 episode 的 prompt 不含上一轮重复自我叙事，但能通过 handoff 引用其真实产物和证据。
6. 用户新消息或真实 schedule 到达后能从持久 ledger 正确恢复，证明“有界 episode”没有破坏永续生命周期。

上线观察可先用六个简单指标，不需要建设完整 observability 平台：

| 指标 | 定义 | 期望趋势 |
| --- | --- | --- |
| external progress ratio | 有 verifier-confirmed delta 的轮次 / 工具轮次 | 上升 |
| equivalent action repeat rate | 同参数或同效果工具重复率 | 下降 |
| duplicate outbound rate | 无新证据的近义主动消息数 | 接近 0 |
| direction coverage | 每日产生真实尝试的不同方向数 | 上升但不过度抖动 |
| context carryover | 新 episode 携带的 token 与完整 ledger token 比 | 显著下降 |
| recovery success | 新事件到达后成功继续原目标的比例 | 不下降 |

再加一个 creativity 指标：产物之间的语义距离不能单独代表质量，应与 evaluator rubric 或真实采用/验证结果配对。否则 Agent 可能用随机噪声刷“新颖度”。

## 8. 不建议作为主方案

- **只增大上下文窗口**：会推迟窗口耗尽，但无法消除 context rot、位置效应和路径依赖。
- **只提高 rest 额度**：不改变错误进展语义；醒来后仍可能重放同一吸引子。
- **每轮强制调用工具**：官方 SDK 明确记录了 forced tool choice 导致无限循环的风险。
- **要求模型多反思几次**：无外部反馈时可能放大原错误。
- **把所有过程写进 Notebook/Memory**：会把循环产物持久化成下一轮原因；只保存验证成功的事实、产物和必要失败签名。
- **立刻增加多个 Agent**：generator/evaluator 分离有价值，但真值来自外部验证；多 Agent 不能自动修正相同上下文和相同评分信号造成的偏差。

## 9. 证据强度与最终判断

- `context anxiety`、clean reset + handoff、generator/evaluator 分离来自 Anthropic 的实际 harness 经验，直接相关但不是受控学术实验。
- lost-in-the-middle、HiAgent、Reflexion、无反馈 self-correction/反思风险、τ-bench 等有同行评审或系统实验支持，任务与 QQ 自主创造仍有外推距离。
- Chroma、ACE、PushBench、Picbreeder-VLM 和部分长期开放式研究是公司技术报告或预印本；适合形成设计假设，不应把单篇数字当产品保证。
- 多个独立来源的共同方向很稳定：**减少工作上下文、用结构化外部状态交接、用真实反馈验证、限制内循环、停滞时换方向、等待事件后干净恢复。**

对 qq-bot-v2 最小且优先级最高的改动不是停掉自主创造，也不是再加休息，而是：

> 先让 `progress` 只代表真实外部 delta；复用现有两轮 no-progress policy 结束有界 episode；在 episode 边界做可重放的干净 working-context reset；用 evidence-backed curriculum 切换方向；对重复自省和无新证据的主动外发做硬限制。

这既保留了“永远寻找创造性的事并持续推进”的产品初衷，也避免把“永远运行”误实现成“同一个上下文永远不结束”。
