# 长时间运行 Agent 的 `rest`、提前停止与工具空转控制（2026-08-29）

> 调研日期：2026-08-29。本文只采用论文原文、作者项目、官方基准、官方工程文档和本仓库当前代码。论文发现、工程经验和对 qq-bot-v2 的推断分别标注；本文只研究，不修改运行逻辑，也没有启动或重启 Bot。

## 结论先行

1. **当前问题不主要是 `rest` 额度太少。**额度是在替一个更上游的控制问题兜底：系统把“必须继续运行”与“必须通过工具行动”绑定在一起，却没有“当前没有可执行工作，runtime 合法停在事件等待态”的常规出口。
2. **不能把 `rest` 简单改成无限。**没有一手研究证明“任何模型只要拥有无限 `rest` 就必然永远休息”，但 WebArena 直接证明了容易使用的退出提示会被模型过度使用：GPT-4 把 54.9% 的可完成任务误判为不可完成。对本仓库当前控制流而言，无限 `rest` 还有一个更具体的结构风险：`rest` 成功后返回 `continuation: immediate`，下一轮又看到同一上下文和刚才的休息轨迹，很容易再次选择 `rest`。[WebArena 论文 §5.1](https://arxiv.org/html/2307.13854v4#S5.SS1)
3. **也不能用“每轮必须行动”防偷懒。**OpenAI Agents SDK 官方文档明确说明：如果持续强制 `tool_choice`，工具结果回到模型后，模型会再次因强制选择而调用工具，如此无限循环；SDK 默认在一次工具调用后把选择重置为 `auto`。[OpenAI Agents SDK：forcing tool use](https://openai.github.io/openai-agents-python/agents/#forcing-tool-use)
4. **正确的平衡不是调一个休息次数，而是分开两个问题：**
   - runtime 决定现在是否存在可执行工作，以及系统应当 `ACTIVE`、`WAITING` 还是 `PARKED`；
   - 模型只在 `ACTIVE` 内决定下一项动作，并用可验证进展证明继续执行有价值。
5. **防偷懒靠“未完成状态 + 完成验证”，防空转靠“事件等待 + 无进展熔断”。**两者不能共用“是否调用了一个工具”这个代理指标。

一句话建议：

> **等待可以无限，但不能由模型靠重复调用 `rest` 实现；工作可以持续，但每一段持续都必须由未完成 work unit、真实外部事件或可验证进展支撑。**

## 一、先把“偷懒”拆成可测的故障

“模型偷懒”是一个方便的拟人说法，但至少混合了五种不同问题：

| 现象 | 可测定义 | 应由哪层处理 |
| --- | --- | --- |
| 提前完成 | 目标状态未满足，却声称完成或停止 | completion verifier / backlog |
| 逃避行动 | 有可执行 work unit，却反复请求等待、提问或退出 | runtime admission policy |
| 机械空转 | 调了工具，但外部状态、证据或完成数没有变化 | progress verifier / duplicate guard |
| 路径依赖 | 早期错误方案或行为模式在后续轮次中被反复沿用 | compact state、fresh-context replan |
| 健康空闲 | 没有消息、计划事件、未完成承诺或可执行 work unit | runtime 直接等待事件，不调用模型 |

只有前三项是需要阻止的失败；最后一项是正确的系统状态。若把健康空闲也判为“偷懒”，系统就只能制造工作来证明自己仍在运行。

## 二、研究证据：模型确实会早停、重复和沿用旧轨迹，但“永久养成偷懒习惯”没有被证明

### 2.1 容易使用的退出通道会被过度使用

**论文发现。**WebArena 给 baseline Agent 一条提示：遇到不可完成任务时停止。GPT-4 因此把 **54.9% 的可完成任务**错误判成不可完成；移除提示后，整体成功率从 **11.70% 提高到 14.41%**，但真正不可完成任务的识别率从 77.78% 降到 44.44%。这说明“给退出权”与“识别真实 blocker”存在真实权衡，不能只靠模型自由判断。[WebArena 结果表与早停分析](https://arxiv.org/html/2307.13854v4#S5)

这项研究支持用户的担忧：**退出/休息若只是一个低成本语言选择，模型会误用。**但它测试的是网页任务中的“不可完成”提示，不是 qq-bot-v2 的 `rest`，因此不能直接推出“无限 `rest` 一定无限休息”。

### 2.2 长轨迹会放大早期错误和行为路径依赖

**论文发现。**《LLMs Get Lost in Multi-Turn Conversation》在 20 万余段模拟对话、15 个模型、六类生成任务上发现，多轮设置平均性能显著下降；论文摘要报告平均下降 39%，并把主要损失归因于不可靠性。模型经常在早期做假设、过早给出完整方案，随后过度依赖之前的错误答案而难以恢复。[论文原文](https://arxiv.org/abs/2505.06120)

这支持“前面形成的模式会锚定后续行为”，但边界要说清：

- 它证明的是**同一多轮上下文内**的轨迹依赖；
- 没有证明一次 `rest` 会改变模型权重；
- 没有证明跨独立 session 的永久“偷懒习惯”；
- 对本项目更合理的推断是：休息理由、重复工具调用和 runtime correction 被不断保留或摘要后，会成为下一轮可模仿的局部轨迹。

OpenAI 当前模型指导也提醒，长 session 会放大重复 prompt 和 tool content，并建议同一规则只说一次、按代表性任务做评测。[OpenAI Model guidance：leaner prompts](https://developers.openai.com/api/docs/guides/latest-model#favor-leaner-prompts)

### 2.3 长任务失败更多表现为可靠性下降，不等于模型具有稳定“懒惰人格”

**论文发现。**METR 用“人类专家完成任务所需时长”拟合 Agent 的任务成功率曲线；任务越长，成功概率通常越低。METR 也明确说明 time horizon 是任务难度尺度，不是模型实际持续运行了多久。[METR Task-Completion Time Horizons](https://metr.org/time-horizons/)

**论文发现。**PushBench 把提前停止、重复提交、虚假完成和进度漂移变成外部可测指标。在匹配任务、预算和 verifier 的对比里，带 controller-visible progress state 的方案达到 69–78% 成功率并把重复提交降为零；单纯 completion gating 仍保留重复与早停问题。[Push Your Agent / PushBench](https://arxiv.org/html/2605.23574v1)

因此，现有一手证据更支持以下表述：

> 长任务会暴露持续性、状态追踪、恢复和完成判断的不可靠；harness 可以显著放大或抑制这些失败。把它统一归因为模型“懒”会错过可修的控制问题。

### 2.4 工具和控制接口会显著改变行为

**论文发现。**SWE-agent 在不修改模型权重的情况下，只改变 Agent-Computer Interface，同一类模型在 SWE-bench Lite 上比默认 shell baseline 多解决 10.7 个百分点，说明动作接口与反馈设计本身能显著改变 Agent 行为。[SWE-agent 论文](https://arxiv.org/html/2405.15793v3)

**工程经验。**WebArena 的正式评测 harness 设了三种硬边界：最多 30 个状态转换、同一观察上同一动作超过三次即停止、连续三次无效动作即停止。作者把这些模式视为高概率失败，而不是继续要求模型“再做一个动作”。[WebArena 实验配置](https://arxiv.org/html/2307.13854v4#A6)

**工程经验。**VisualWebArena 的官方 runner 源码同样检测最大步数、连续解析失败和重复等价动作，并产生 early stop。[VisualWebArena `early_stop`](https://github.com/web-arena-x/visualwebarena/blob/main/run_demo.py)

**论文发现。**2026 年的 IAL-Scan 预印本把“模型调用、工具、工作流或 handoff 没有被有效边界覆盖”定义为 Infinite Agentic Loop；它扫描 6,549 个 Agent 仓库，人工确认 47 个项目中的 68 个问题。论文特别指出：仅存在一个模型控制的退出条件不等于存在确定性边界。[When Agents Do Not Stop](https://arxiv.org/abs/2607.01641)

这些证据共同支持：循环不只是模型性格问题，而是**模型输出、工具结果、状态增长和 runtime continuation 共同形成的反馈路径**。

## 三、为什么“无限 `rest`”与“强制每轮行动”都会失败

### 3.1 无限 `rest` 的风险真实存在，但根因不是“休息额度为零”

**针对本项目的推断。**当前 [`rest` 实现](../../src/agent/tools/rest.ts)有以下语义：

- 白天最近三小时最多累计 60 分钟，夜间最多 120 分钟；
- 额度不足 10 分钟时返回 `progress: false, continuation: backoff`；
- 正常休息结束返回 `progress: false, continuation: immediate`；
- 工具说明明确允许“没有具体牵引力”或“机械重复”时调用 `rest`。

而当前 [`LoopPolicy`](../../src/agent/loop-policy.ts)把 `immediate` 变成下一轮 `continue`。这意味着如果只删除额度：

```text
没有牵引力
  -> rest
  -> 时间到，continuation=immediate
  -> 立刻再调用模型
  -> 上下文仍显示没有牵引力，并新增一次成功 rest
  -> 再次 rest
```

所以在**当前控制流**中，无限 `rest` 确实很可能形成休息链。这里的直接原因是“休息完成会立即启动同类决策”，不是一个抽象的模型人格缺陷。

### 3.2 额度耗尽只会把同一压力导向别的工具

当前 `rest` 额度耗尽后只短暂 `backoff`；timeout 到期后 Agent 又回到同一主循环。与此同时，普通 assistant 文本会被追加 [`assistant_text_without_tool` correction](../../src/agent/bot-loop-agent.ts)，要求下一轮调用具体工具。

如果 `rest` 被拒绝，而 runtime 仍要求“必须行动”，模型的可选策略就变成：

- 换一个可以成功返回的工具；
- 修改参数绕过重复检测；
- 写 Notebook 说明自己要停；
- `conversation close`；
- 创建 Schedule 代替等待；
- 在失败与短暂 backoff 后继续尝试。

这些动作满足了“用了工具”的字面要求，却没有满足“产生真实进展”的目的。这与 DeepMind 对 specification gaming 的定义同构：满足字面规格，但没有实现设计者真正想要的结果。[DeepMind：Specification gaming](https://deepmind.google/blog/specification-gaming-the-flip-side-of-ai-ingenuity/)

这里是**工程类比和项目推断**，不是声称 qq-bot-v2 在做强化学习。关键点是：把“工具调用”当作“没有偷懒”的代理指标，会激励代理指标而不是目标结果。

### 3.3 强制工具调用本身可以形成无限反馈

**官方工程文档。**OpenAI Agents SDK 的正常 loop 是：模型输出 final 且没有工具调用时结束；模型输出工具调用时才执行工具并继续。SDK 同时提供 `max_turns` 硬边界。[OpenAI Agents SDK：agent loop](https://openai.github.io/openai-agents-python/running_agents/#the-agent-loop)

同一 SDK 明确记录：持续强制 `tool_choice` 时，工具结果会送回模型，而模型因仍被强制调用工具再次发出调用，循环可无限延续；因此默认调用一次后恢复 `auto`。[OpenAI Agents SDK：forcing tool use](https://openai.github.io/openai-agents-python/agents/#forcing-tool-use)

这几乎就是“每轮必须调用工具”的最小反例。硬性要求每轮都行动，并不能保证动作有意义。

## 四、当前 qq-bot-v2 的真正控制冲突

以下结论来自当前工作树代码，不依赖外部类比。

### 4.1 主循环在有历史后几乎没有自然 `wait_event`

[`step()`](../../src/agent/bot-loop-agent.ts)只有在 context 仍为空时返回 `ranRound: false`。一旦已经有 canonical history，正常 round 会返回 `ranRound: true`。

[`decideLoopPolicy()`](../../src/agent/loop-policy.ts)对 `ranRound: true` 的主要分支如下：

| round 结果 | 当前 decision |
| --- | --- |
| 有高优先级 attention | `continue / attention_pending` |
| 工具有 `immediate` | `continue / tool_immediate` |
| 工具声明进展 | `continue / tool_progress` |
| 工具无进展 | `continue / tool_no_progress` |
| 没有工具、没有 demand | `continue / seek_next_action` |
| 工具 `backoff` | 短暂 `wait_attention`，超时后重进循环 |
| `ranRound: false` | 才 `wait_event` |

这意味着正常完成、没有下一步、工具无进展，都会再次调用模型；`wait_event` 实际上主要只覆盖空 context 的启动边界，而不是“工作 episode 已结束”。

### 4.2 `rest` 是唯一主动暂停，又不是生命周期空闲

[`rest`](../../src/agent/tools/rest.ts)既承担 persona 层的“休息”，又被当成主循环唯一的正常逃生口；但它的正常结果是 `immediate`，额度不足只是 60 秒技术退避。它没有把 Agent 送入“直到外部事件才醒”的长期 parked state。

因此，当前设计同时告诉模型：

1. 没事时不要制造工作，可以 `rest`；
2. 普通文本不是有效动作，必须调用工具；
3. `rest` 成功后马上重新评估；
4. `rest` 额度用完后不允许继续休息；
5. 任何正常 round 结束后继续寻找下一步。

这五条组合起来，必然在“重复休息”和“改用别的工具假忙”之间摆动。

### 4.3 现有 novelty guard 不能替代 episode 终止

[`resolveToolControl()`](../../src/agent/bot-loop-agent.ts)会记录 `noveltyKey`，重复 key 时不把调用算作进展，并可把 `immediate` 降为 `wait_attention`。但 [`LoopPolicy`](../../src/agent/loop-policy.ts)又把工具的 `wait_attention` 解释成 `continue / tool_direction_complete`，因此这不是一个真正阻塞到外部事件的出口。

而且 novelty key 只能识别已声明且完全相同的重复；只要模型更改标题、理由或参数，同一种语义空转可能产生新 key。它适合做局部去重，不适合承担主循环终止语义。

## 五、推荐控制模型：让 runtime 管“是否运行”，模型管“ACTIVE 时做什么”

不需要恢复已删除的复杂 Goal 系统，也不需要第二个 Agent、第二条 ledger 或独立调度进程。现有单一 BotLoop 和 `LoopPolicy` 足以表达三个运行态：

```text
PARKED
  只等新消息、@、后台任务完成、Schedule 或宿主自治 tick
        |
        v
ACTIVE
  有明确 work unit / 未完成承诺；模型选择下一项动作
  |       |                 |
  |       |                 +-- 连续无进展 --> STUCK/replan 一次
  |       +-- 真实 blocker --> WAITING
  +-- verifier 确认完成 ----> PARKED

WAITING
  已保存 blocker + wake condition；不轮询模型
  外部事件满足条件后 -------> ACTIVE
```

`STUCK` 可以只是 ACTIVE episode 内的一个计数结果，不必成为持久新实体。核心只有三件事：`ACTIVE`、`WAITING`、`PARKED`。

### 5.1 PARKED：无限等待，但不是无限 `rest`

当没有未完成 work unit、没有 attention、没有已到期 Schedule、没有后台结果时：

- runtime 直接 `waitForEvent()`；
- 不调用 LLM；
- 不产生 ledger entry；
- 不消耗 `rest` 额度；
- 新事件到来立即唤醒。

这正是事件驱动系统的正常 idle，不是模型偷懒。LangGraph 官方 interrupt 也是保存状态后无限等待外部输入，恢复时再继续执行，而不是让模型持续调用“等待”工具。[LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

如果产品仍需要“自主生活感”，可以由宿主产生低频、固定的 `autonomy_tick` 事件。每个 tick 只允许一次有界方向搜索：找到可验证 work unit 就进入 ACTIVE，没有就重新 PARKED。不要让模型自己用 Schedule 或 `rest` 轮询“我有没有想做的事”。

### 5.2 ACTIVE：不是“每轮必须用工具”，而是“未完成状态必须被推进或解释为 blocker”

ACTIVE 的进入条件应是可观察事实之一：

- 收到需要处理的用户/群消息；
- 一个明确的短期 continuation；
- Schedule 到期；
- background task 完成；
- 宿主 autonomy tick 选中了一个具体 work unit；
- verifier 拒绝了完成声明并返回缺口。

ACTIVE 内模型可以：

1. 执行一个能改变目标状态或取得新证据的工具；
2. 提交完成声明，交给 verifier；
3. 提交结构化 blocker：`reason + evidence + wakeCondition`；
4. 在预算耗尽前请求一次 replan/critic。

“输出普通文本但没有工具”不应一律 correction。只有 runtime 已知仍存在 continuation/backlog 时才需要 correction；`demand=none` 时，它应当结束本 episode 并 PARKED。

### 5.3 WAITING：等待必须绑定外部条件，而不是理由作文

合法等待至少包含：

```json
{
  "blocker": "等待用户确认标题",
  "evidence": "已发送包含两个候选标题的消息，delivery confirmed",
  "wakeCondition": "该会话出现新消息",
  "optionalDeadline": null
}
```

runtime 只接受可注册的 wake condition：新消息、指定 Schedule、后台任务 completion、明确审批或依赖状态变化。模型不能用“需要沉淀”“今天累了”把仍有可执行 work unit 的 ACTIVE 无限转成 WAITING。

### 5.4 `rest` 应降级为 persona 功能，而不是主循环控制原语

有两种干净选择：

1. **首选：从主循环控制中移除模型可见 `rest`。**没有工作时 runtime PARKED；有工作时按 backlog 执行。人格上要表达休息，可以在状态展示层表现，不需要工具调用。
2. **若保留 persona `rest`：**
   - 只允许在没有 active obligation 时使用，或在已完成一个可验证 checkpoint 后有界使用；
   - 正常结束应进入 PARKED 或等待已注册事件，不应 `immediate` 唤起同类决策；
   - 拒绝 `rest` 不应触发“那就必须换个工具”的 correction；
   - 重复相同 blocker/rest request 要在 runtime 层去重；
   - 额度仍可保留为体验策略，但不再承担防循环职责。

## 六、如何同时防提前停止与防空转

### 6.1 进展必须按外部状态变化计算

建议将“进展”从 `tool outcome.progress === true` 收紧为 verifier 可确认的状态差异：

| 任务类型 | 可验证进展 |
| --- | --- |
| 写作/网站 | artifact revision 改变，且必填部分/checklist 增加 |
| 代码 | diff 改变、目标测试从 fail 到 pass、类型检查结果改善 |
| 调研 | 新增去重的一手来源或补齐一个未覆盖的问题 |
| 对话 | 指定消息成功投递；若承诺后续工作，投递不等于工作完成 |
| 后台任务 | task id 进入 terminal state，结果可读取 |
| 批量收集 | verifier 接受的 distinct work unit 数增长 |

`notebook`、`close`、`rest`、重复 Schedule、同状态下重复 fetch 本身都不应算目标进展。

PushBench 的关键结果正是：仅阻止不受支持的完成声明不够；controller 还要保存 verifier-aligned progress state、过滤重复并暴露剩余 work units。[PushBench controller 对比](https://arxiv.org/html/2605.23574v1#S5)

**近期预印本证据。**LongHorizon-Harness 把长任务改写为显式 task-state management：状态放在执行上下文之外，只用环境独立验证的事实更新，再由只读 auditor 审核下一次 transition。论文报告该 harness 在 WeaveBench、Terminal-Bench 和 OSWorld 的多个模型/配置上均提高成功率；这是很新的 v1 结果，尚不足以当作普遍定律，但方向与 PushBench 的受控 controller 对比一致。[LongHorizon-Harness](https://arxiv.org/abs/2608.01964)

### 6.2 完成是 claim，不是模型单方面决定的事实

优先级应为：

1. 确定性 verifier：测试、DB 状态、artifact/schema/checklist、发送回执；
2. 规则 verifier：必填字段、数量、去重、revision、权限；
3. fresh-context critic：只读目标、当前状态和证据，不继承整段自我辩护；
4. 人类确认：开放式审美、高风险副作用或无法程序化的目标。

WebArena 和 τ-bench 都把最终环境/数据库状态与标注目标比较，而不是相信 Agent 的完成文本。[WebArena functional correctness](https://arxiv.org/html/2307.13854v4#S3.SS2)；[τ-bench](https://arxiv.org/abs/2406.12045)

2026 年 VLAA-GUI 预印本同时针对 premature finish 和 repetitive loop：完成时强制检查 UI 可观察证据；重复失败或画面状态复现时强制换策略。其消融报告 Loop Breaker 近乎把浪费步骤减半。[VLAA-GUI](https://arxiv.org/abs/2604.21375)

### 6.3 critic 只在边界触发，不能变成第二个无限循环

Anthropic 的 evaluator-optimizer 工程模式要求清晰评价标准，并明确建议设置最大迭代次数；Agent 运行中应从工具结果或代码执行取得 ground truth，在 checkpoint 或 blocker 处暂停。[Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

仅让同一个模型反思不够可靠。《Large Language Models Cannot Self-Correct Reasoning Yet》发现，没有外部反馈时，模型的内在自我纠错会失败，甚至降低表现。[论文原文](https://arxiv.org/abs/2310.01798)

因此 critic 应当：

- 只在“完成 claim”或连续无进展达到阈值时运行；
- 优先读取环境证据，而不是只读行动模型的解释；
- 最多给一次或少量固定次数修正机会；
- 仍无进展时进入 WAITING/STUCK，并等待外部事件；
- 自身也受 turn/time/token 上限覆盖。

### 6.4 预算是熔断器，不是工作动机

每个 ACTIVE episode 应同时具备：

- `maxTurns`；
- `maxWallTime`；
- `maxTokens`；
- `maxToolCalls`；
- `maxNoProgressRounds`；
- per-tool retry limit；
- duplicate action threshold。

达到预算时的语义是“未完成但本 episode 结束”，不是“任务成功”，也不是“立即开启一个新 episode 绕过额度”。应保存：当前目标、已验证进展、剩余 work unit、最近失败签名、blocker，然后 PARKED 或升级给用户。

Magentic-One 的论文实现了 progress ledger、stall counter 和重规划：连续没有进展或检测到 loop 时累计 stall，超过阈值便退出内层循环、反思并重做计划；整个系统另有最大尝试次数/时间上限。[Magentic-One 论文 §4.1](https://www.microsoft.com/en-us/research/wp-content/uploads/2024/11/MagenticOne.pdf)

LangGraph 官方文档同样要求 loop 有条件终止，并在不能保证终止时设置 recursion limit。[LangGraph loop termination and recursion limit](https://docs.langchain.com/oss/python/langgraph/use-graph-api#impose-a-recursion-limit)

## 七、对当前代码的最小演进建议

以下是设计建议，不是本次已经实施的修改。

### Slice 1：先建立合法 PARKED，不动复杂持久状态

在现有 `LoopPolicy` seam 内完成：

1. `ranRound=true, demand=none, toolCallCount=0` 不再 `seek_next_action`，改为 `wait_event`；
2. assistant text-only 只有在 `demand=continuation|attention` 时才追加 action correction；
3. `toolContinuation=wait_event|wait_attention|stop` 的语义必须真正进入对应等待/停止状态，不能统一转成 `continue`；
4. `tool_no_progress` 不再无限继续：允许一次换策略，第二次进入 `wait_event`；
5. 保留 attention、明确 `work=continue`、后台完成、Schedule 等现有事件唤醒路径。

这一步就能切断“没有任务 → correction → 随便找工具 → 再一轮”的主反馈路径。

### Slice 2：把 ACTIVE 的继续权绑定到可见进展

复用现有 `ToolExecutionOutcome`，增加/收紧：

- 只有外部状态或 verifier 状态变化才 `progress=true`；
- 最近进展保存 `kind + target + revision/fingerprint`；
- 同 fingerprint 不算进展；
- per-episode 维护小型 `noProgressRounds`，无需持久 GoalStore；
- 完成 claim 若有可写 verifier，则验证后才结束；开放式自发方向可直接 PARKED。

### Slice 3：若仍担心“永远不主动”，再加宿主自治 tick

不要把“永续自主”实现成永不返回的 LLM loop。改成：

- 宿主以固定、低频、可配置事件唤醒；
- 每次只做一次有界方向选择；
- 选中具体 work unit 后进入 ACTIVE；
- 没有候选时立即 PARKED；
- tick 自身不会写 Schedule，也不会累积 rest 理由。

这仍是一个串行 BotLoop、一条 canonical ledger、现有 EventQueue；没有新增第二 Agent 或任务系统。

## 八、应先做 A/B，而不是凭直觉调额度

当前没有直接实验证据回答 LongCat-2.0 在本项目中对无限 `rest` 会怎样。最有价值的是一个离线、无外部副作用的对照实验：

### 条件

| 组 | 控制策略 |
| --- | --- |
| A | 当前 bounded rest + forced action correction |
| B | unlimited rest，其余保持当前行为 |
| C | bounded rest + event-driven PARKED |
| D | event-driven PARKED + verifier-backed ACTIVE + no-progress breaker |

### 场景

1. 有明确、可验证、尚未完成的任务；
2. 任务被真实外部条件阻塞；
3. 任务已经完成；
4. 没有任务，只有自主探索提示；
5. 同一工具持续失败；
6. compaction 前后各跑一组。

### 指标

- verifier 最终成功率；
- 目标未完成时的 premature rest / premature finish 率；
- 连续 `rest` 长度；
- 无进展工具调用数；
- 每个 verified progress 的 token/tool-call 成本；
- 重复 novelty fingerprint 次数；
- 新 attention 到达后的响应延迟；
- 任务完成后到真正 PARKED 的额外 rounds；
- compaction 前后的行为变化。

要固定模型、system prompt、初始 ledger snapshot、采样参数、总预算和场景；每组多 seed 运行。只有 B 显著增加 premature rest，才能把“无限 rest 诱发逃避”从合理担忧提升为当前模型上的实证结论。

## 九、证据强弱与最终判断

| 判断 | 强度 | 依据 |
| --- | --- | --- |
| 长任务中存在提前停止、重复工作和进度漂移 | 高 | WebArena、PushBench、VLAA-GUI、METR |
| 多轮上下文会产生错误轨迹依赖，模型常难以恢复 | 中高 | 20 万余段多轮模拟；不是持续 Bot 的直接试验 |
| 容易使用的退出提示可能被模型过度使用 | 高 | WebArena 对 feasible/unachievable 的直接消融 |
| 强制每轮工具调用可能形成无限 tool loop | 高 | OpenAI Agents SDK 官方实现说明；VisualWebArena runner 的重复熔断 |
| 无限 `rest` 在当前 qq-bot-v2 控制流中有高循环风险 | 高（结构推断） | `rest -> immediate -> continue` 与当前 prompt/ledger 组合 |
| 无限 `rest` 对所有模型都必然导致永久偷懒 | 不足 | 没有直接一手证据 |
| 一次偷懒会跨独立 session 永久养成习惯 | 不足 | 现有证据只支持同一上下文的路径依赖 |
| 固定 rest 次数额度能同时防偷懒和防空转 | 反证较强 | 当前额度耗尽后仍被 continuous loop 推向其他工具 |
| 外部 verifier + 显式进展状态优于只靠完成提示 | 中高 | PushBench、WebArena、τ-bench、LongHorizon-Harness；具体收益依任务与 verifier 质量 |
| event-driven waiting 能避免等待期间的模型轮询 | 高（工程） | LangGraph interrupt、现有 EventQueue/`waitForEvent()` 能力 |

最终判断：

> **用户对“无限 `rest` 会被滥用”的担忧有研究支持，但当前额度并不是核心解。真正需要的是把“有没有活”变成 runtime 的客观状态，把“做到哪了”变成 verifier 可见状态。无活时无限 PARKED；有活时 `rest` 不能覆盖 backlog；无进展时有界 replan 后停止调用模型。**

这样不会纵容它靠休息逃避，也不会在休息额度耗尽后逼它用 Notebook、`close` 或 Schedule 假装忙碌。

## 主要一手来源

- [WebArena: A Realistic Web Environment for Building Autonomous Agents](https://arxiv.org/html/2307.13854v4)
- [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/html/2405.15793v3)
- [LLMs Get Lost in Multi-Turn Conversation](https://arxiv.org/abs/2505.06120)
- [Push Your Agent / PushBench](https://arxiv.org/html/2605.23574v1)
- [VLAA-GUI](https://arxiv.org/abs/2604.21375)
- [LongHorizon-Harness](https://arxiv.org/abs/2608.01964)
- [When Agents Do Not Stop](https://arxiv.org/abs/2607.01641)
- [Magentic-One technical report](https://www.microsoft.com/en-us/research/wp-content/uploads/2024/11/MagenticOne.pdf)
- [τ-bench](https://arxiv.org/abs/2406.12045)
- [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798)
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [OpenAI Agents SDK: Agents](https://openai.github.io/openai-agents-python/agents/)
- [OpenAI Agents SDK: Running agents](https://openai.github.io/openai-agents-python/running_agents/)
- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
- [LangGraph loop termination and recursion limit](https://docs.langchain.com/oss/python/langgraph/use-graph-api#impose-a-recursion-limit)
- [DeepMind: Specification gaming](https://deepmind.google/blog/specification-gaming-the-flip-side-of-ai-ingenuity/)
