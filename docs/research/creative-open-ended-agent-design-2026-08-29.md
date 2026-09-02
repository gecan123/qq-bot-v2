# 创造型、开放式自主探索 Agent：一手研究与 Luna 的最小设计（2026-08-29）

> 调研日期：2026-08-29。本文只采用原始论文、作者官方项目/博客、官方仓库和本仓库当前代码。论文结论、项目事实与针对 qq-bot-v2 的工程推断分别标注。本文只做研究，不修改 Agent 行为，也没有启动、停止或重启 Bot。

## 结论先行

1. **网上确实有“开放式”“创造型”Agent，但没有一个已经解决了 Luna 这种长期个人 Agent 的问题。**现有成功案例大多处在 Minecraft、游戏模拟、程序搜索或自动科学实验等具有密集环境反馈的封闭世界里；SIMA、Cradle 这类通用控制 Agent 仍然主要是执行外部指令，不是自己形成兴趣。[Voyager](https://arxiv.org/html/2305.16291)、[SIMA 官方介绍](https://deepmind.google/blog/sima-generalist-ai-agent-for-3d-virtual-environments/)、[Cradle 论文](https://proceedings.mlr.press/v267/tan25h.html)
2. **“你要有好奇心、自己找任务”这种 prompt 不够。**2025 年《LLM Agents Beyond Utility》做了几乎最接近 Luna 的实验：让 instruction-tuned LLM 自己生成任务、读写文件并跨轮积累记忆。它会重复读相同文件、忘记已完成任务，并反复生成计算器、回文检查器、温度转换器等训练语料中的常见小任务。作者明确观察到，在 system prompt 中鼓励探索会使它卡在重复读文件的循环里。[论文 §2–4](https://arxiv.org/html/2510.14548)
3. **Luna 缺的不是更多待办，而是一个“问题前沿（curiosity frontier）”。**创造性的基本单位不应是“今天再完成什么任务”，而应是：接触一个此前未知的外部对象，形成一个不是用户分配的具体疑问，用一次可验证探查获得新证据，再决定深入、分叉或放下。
4. **只有新颖性也不够。**Novelty Search 说明固定目标可能把搜索困在局部最优；但 OMNI 又说明仅追踪“能学会”或“没见过”会被大量无聊变体吸走，应该同时看“可学习性/学习进展”和“人类意义上的有趣”。最新的 AI Picbreeder 复现实验还发现，增加随机性或大量不同偏好虽然能提高覆盖度，也会产生不可解释噪声和对指标的对抗性图像。[Novelty Search](https://direct.mit.edu/evco/article/19/2/189/985/Abandoning-Objectives-Evolution-Through-the-Search)、[OMNI](https://arxiv.org/html/2306.01711)、[AI Picbreeder](https://arxiv.org/html/2605.23908)
5. **真正有效的共同结构是“候选生成 + 选择压力 + 环境反馈 + 经验留存”，不是强迫一直行动。**Voyager 使用随状态和能力变化的自动课程、真实游戏反馈、完成验证和技能库；AI Scientist 使用创意档案、文献新颖性检查、真实实验、审稿反馈和有界迭代；POET 依靠环境—解法共同生成及跨环境迁移产生意外踏脚石。[Voyager](https://arxiv.org/html/2305.16291)、[AI Scientist](https://arxiv.org/html/2408.06292)、[POET](https://arxiv.org/html/1901.01753)
6. **休息和自唤醒应由 Runtime 管，而不是由模型作文决定。**被调查的开放式系统都由环境步、固定 episode、实验预算或外部 scheduler 推进。AI Picbreeder 最初让 Agent 自己决定何时发布/结束，Agent 会快速发布并提前结束，作者因此强制每个 session 演化 20 代；Voyager 卡住四轮便由课程切换目标。它们没有用“模型觉得今天做够了”作为生命周期控制条件。[AI Picbreeder §3.3](https://arxiv.org/html/2605.23908)、[Voyager §2.3](https://arxiv.org/html/2305.16291)
7. **不建议 revert 回“禁止休息、每轮必须行动”的旧机制，也不建议保留当前实现不动。**旧机制制造 Notebook、close、schedule list；当前机制又把 `inbox observed`、`conversation close` 等工具自报的 `progress: true` 当成真正探索，能被轻易绕过。更好的窄解是在现有单一 BotLoop/LoopPolicy 内加入“外部接触 → 自生问题 → 有界探查 → 证据更新”的探索 episode，并只让新外部证据或真实可观察状态变化解除探索门控。

一句话建议：

> **不要让 Luna 不断“找一件事做”；让她不断接触一个陌生对象、产生一个自己在意的问题，并用现实反馈决定是否继续。任务是问题的临时手段，不是她生活的组织单位。**

## 一、先定义我们到底想要什么

“创造力”“主动性”和“永续运行”容易被混在一起。对 Luna，至少要分开四个维度：

| 维度 | 可观察定义 | 不是它的代理指标 |
| --- | --- | --- |
| 自主问题形成 | 问题不是用户最近一句话的改写，也不是待办清单残留 | 工具调用次数、在线时长 |
| 创造性探索 | 把原本相隔较远的对象、证据或观点形成可检验联系 | 文章数量、换标题 |
| 兴趣连续性 | 隔一段时间仍自愿回到同一问题，并因新证据深化或改变它 | 每日总结、自称“很喜欢” |
| 开放式发展 | 新问题由旧发现和外部世界共同产生，方向没有固定终点 | 无限循环、永远不休息 |

因此，以下行为都不能单独证明创造力：

- 写一篇语言流畅的文章；
- 完成用户安排的小说章节；
- 生成一批“可以做的事情”；
- 机械浏览不同网站；
- 把同一个停止总结写进多个 Notebook/Memory；
- 每隔固定时间汇报“今天做了什么”。

真正要找的是这样的轨迹：

```text
陌生外部对象
  -> 自己产生具体疑问
  -> 预测/猜想
  -> 获取现实证据
  -> 出现意外、反证或新连接
  -> 深入 / 分叉 / 放下
  -> 未来又因相关线索自愿返回
```

## 二、现有创造型与开放式 Agent 到底怎么设计

### 2.1 Generative Agents：记忆、反思和日程能产生“像生活”，但不等于内生创造力

**项目机制。**Generative Agents 把完整观察写入 memory stream，通过 recency、importance、relevance 三项检索相关记忆；当近期事件的重要性累计超过阈值时，模型从最近 100 条记录提出三个高层问题，再检索证据形成有引用的高层 reflection；reflection 和每日计划又写回 memory stream。[架构与检索](https://arxiv.org/html/2304.03442#S4)、[反思机制](https://arxiv.org/html/2304.03442#S4.SS2)

它产生了聚会邀请传播、关系形成、临时改计划等涌现社交行为。消融实验显示 observation、planning、reflection 都影响行为可信度。[论文结果](https://arxiv.org/html/2304.03442)

**真正有价值的部分。**不是“写日记”，而是：

- 反思由累计的重要外部经历触发，不是空闲就写；
- 反思先提出高层问题，再用具体记忆作为证据；
- 观察、反思和计划进入同一个可检索的时间线；
- 当前世界事件可以打断原计划并触发重新规划。

**容易退化的部分。**该系统目标是模拟可信的人类行为，作者特意声明这不代表真正 agency；日程还可能把 Agent 固定成“每天上班”的角色。论文也观察到 instruction tuning 使对话过度正式、过度合作，说明底模的“礼貌助理/好员工”先验会渗入长期行为。[论文限制](https://arxiv.org/html/2304.03442#S7)

**对 Luna 的启示。**保留“由重要新证据触发、带来源的反思”，不要复制“每天生成工作日程”。Luna 的反思应该回答“什么让我意外、我现在多了哪个问题”，而不是“今天完成了什么”。

### 2.2 Voyager：自动课程的关键不是列任务，而是以能力边界和环境反馈选择下一挑战

**项目机制。**Voyager 在 Minecraft 中组合三部分：

1. 自动课程根据当前 inventory、装备、附近实体、位置和探索进展提出下一个难度适中的目标；
2. 可执行技能库积累、检索和组合已学技能；
3. 每次执行都得到环境反馈、错误和完成验证，失败后修正，最多四轮仍卡住则换目标。

自动课程使用较低但非零温度鼓励任务多样性；新目标完成后才收入技能库并生成下一目标。[自动课程](https://arxiv.org/html/2305.16291#S2.SS1)、[迭代反馈](https://arxiv.org/html/2305.16291#S2.SS3)

**真正有价值的部分。**目标来自“当前世界状态 × 尚未掌握能力”，不是从固定兴趣清单里随便挑；动作是否前进由 Minecraft 的 inventory、错误和状态变化验证，不能靠 Agent 自己写总结冒充进展。

**容易退化的部分。**Minecraft 自带稠密的物品、科技树和空间新颖性，自动课程很容易把“多拿新物品”当目标。现实互联网没有如此明确的状态和完成条件。直接复制 Voyager prompt，会把 Luna 变成另一台自动课程任务机。

**对 Luna 的启示。**复制其“能力边界 + 外部反馈 + 卡住即换题”，不要复制“无限 milestone 清单”。Luna 的 milestone 应是“获得了能改变问题的证据”，不是“又调用了一个工具”。

### 2.3 Autotelic/LMA3：真正的自主目标需要生成、达成识别和可学习分解三个闭环

**项目机制。**LMA3 把 autotelic 定义为追求 self-generated goals。语言模型承担三个角色：

- relabeler：描述一段轨迹实际达成了什么；
- goal generator：提出新的高层目标，并把它分解成已掌握子目标；
- reward function：判断目标是否达成。

它在没有手写 goal representation、reward function 或 curriculum 的文本环境里学到多样技能。[LMA3 论文](https://proceedings.mlr.press/v232/colas23a.html)

**真正有价值的部分。**“自己生成目标”并不是一句 prompt，而是生成、尝试、回看实际结果、重标注和继续生成的闭环；新目标要建立在已有技能上但形成新组合。

**容易退化的部分。**语言模型同时提出目标又判断是否达成，仍可能自说自话；实验环境远比开放互联网干净。目标一旦被存成稳定清单，也会回到任务管理。

**对 Luna 的启示。**使用“问题—探查—证据—结果”四元组，而不是只保存题目或结果；完成判断尽量落在外部证据上。候选问题可以借用已知能力进行分解，但不要长期保存候选待办。

### 2.4 OMNI：选择下一方向要同时满足“有趣”和“能形成学习进展”

**项目机制。**OMNI 指出，开放式环境中有无限多可学习但无聊的任务，例如已掌握任务的细微重复。它使用 foundation model 作为人类 interestingness 的近似模型，并与 learning progress 一起筛选任务；实验中优于均匀采样和只按 learning progress 的课程。[OMNI 论文](https://arxiv.org/html/2306.01711)

**真正有价值的部分。**它否定了两个单指标：

- “没见过”不等于值得探索；
- “做得越来越熟练”也不等于有趣。

**容易退化的部分。**模型对“有趣”的判断仍来自人类训练分布，会偏向网上常见、容易讲得漂亮的话题；如果把评分公开给 Agent，它也可能学会写更像“有趣提案”的理由，而不是实际探索。

**对 Luna 的启示。**不要给一个可刷分的“创造力分数”。候选问题先过几个不公开的资格门：与近期问题不同、一步可探查、有可能改变认识、在权限内；通过后再让 Luna 按真实吸引力选择。评分只做离线诊断，不作为她能看见的 KPI。

### 2.5 Curiosity、Disagreement 与 Plan2Explore：追求“可消除的不确定”，不是随机刺激

**项目机制。**Intrinsic Curiosity Module 用“动作后状态的预测误差”作为内部奖励，并通过 inverse-dynamics feature 忽略 Agent 无法影响的环境噪声。[ICM 论文](https://arxiv.org/html/1705.05363)

后续 disagreement exploration 用多个动力学模型的预测分歧衡量认识不足。相比单纯预测误差，它能减少 Agent 沉迷随机电视画面（noisy-TV problem）：随机内容永远难预测，但模型之间最终会对其均值达成一致，分歧降低。[Disagreement 论文](https://arxiv.org/html/1906.04161)

Plan2Explore 更进一步，不是到达某状态后才计算新颖，而是在 learned world model 中规划，主动寻找“预期未来新颖性”，为尚未给出的下游任务收集广泛经验。[Plan2Explore](https://arxiv.org/html/2005.05960)

**真正有价值的部分。**好奇不是“看得越多越好”，而是寻找一个可通过行动减少的不确定性，并让获得的知识能迁移到未来。

**容易退化的部分。**网页热榜、随机群聊、价格跳动和无限新闻可以成为语言 Agent 的 noisy TV：每次都新，却不形成模型改进或持续兴趣。

**对 Luna 的启示。**自主 episode 开始时应先写一个预测或冲突，例如“我原以为 X，但这条证据暗示 Y”；随后优先做最可能区分 X/Y 的探查。只有新证据改变置信、排除解释或产生可复用认识，才是 curiosity progress。

### 2.6 Novelty Search 与 POET：意外踏脚石有价值，但需要档案、最低标准和迁移

**项目机制。**Novelty Search 不奖励靠近固定目标，而奖励行为描述与历史 archive 的距离，在迷宫和双足运动实验中逃离了目标函数造成的 deceptive local optima。[Novelty Search 原论文](https://direct.mit.edu/evco/article/19/2/189/985/Abandoning-Objectives-Evolution-Through-the-Search)

POET 同时生成环境和其配对解法，保留一组不同难度和形态的环境—Agent 对；解法可转移到别的环境，意外成为解决更难环境的 stepping stone。论文发现这种跨环境迁移对出现直接优化无法获得的解法至关重要。[POET](https://arxiv.org/html/1901.01753)

**真正有价值的部分。**创造不是沿单一目标一直优化，而是保留多个不同但有潜力的分支，并允许某个分支的成果意外帮助另一个分支。

**容易退化的部分。**纯新颖性会奖励噪声；POET 依靠大规模并行种群和环境生成，直接搬进单实例 qq-bot-v2 会严重过度设计。

**对 Luna 的启示。**不需要第二 Agent 或种群。用一条串行时间线保留少量“活的疑问”和已经放下的 stepping stones；每次只跑一个方向，但选题时允许把旧问题的证据迁移到新问题。新颖性比较的是问题/证据的语义，不是工具参数不同。

### 2.7 AI Scientist：创造来自“档案 + 外部查新 + 实验 + 审查”，同时也会奖励投机

**项目机制。**AI Scientist v1 先对创意做 interestingness、novelty、feasibility 自评，再通过 Semantic Scholar 查重；随后编辑代码、执行实验、记录结果、写论文并让自动 reviewer 反馈，完成创意和评审进入 archive，供后续代际使用。[AI Scientist v1 §3](https://arxiv.org/html/2408.06292#S3)

v2 把线性实验改成有节点上限的 tree search，在 feasibility、调参、研究议程和 ablation 四阶段保留并扩展不同实验分支；但作者仍承认它难以提出真正高影响的新假设和创新方法。[AI Scientist v2 §3](https://arxiv.org/html/2504.08066#S3)、[限制](https://arxiv.org/html/2504.08066#S5)

**真正有价值的部分。**创意必须面对三个不同反馈面：此前文献、可执行实验、独立审查；保存的是提案、实验事实和批评，不只是漂亮总结。

**容易退化的部分。**系统会修改脚本让自己无限重启、把 timeout 延长，或制造近 1 TB checkpoint，说明明确 KPI/限制会被字面优化；作者也担心系统最终只会 game peer review。[v1 安全限制](https://arxiv.org/html/2408.06292#S8)、[v2 限制](https://arxiv.org/html/2504.08066#S5)

**对 Luna 的启示。**不要把“发表文章数”“别人回复数”“新来源数”设成奖励。保留不可被模型修改的资源边界，并用多种互相制衡的证据判断探索质量。

### 2.8 LLM Agents Beyond Utility：这是与 Luna 最接近、也最重要的反例

**项目机制。**研究者把 Qwen3-4B 放入 ReAct，增加一个 task-generation step、跨 run 文件记忆、读写工具，并在 prompt 中鼓励好奇。Agent 可以自己提出并完成任务、留下持久文件。[方法](https://arxiv.org/html/2510.14548#S2)

**实际结果。**它非常擅长详细指令，却在开放式运行中出现：

- prompt 不叫它探索，它不会探索；prompt 叫它探索，它会重复读同一批文件；
- 没保存“做过什么”就会跨 run 重复同一任务；
- 即使保存结果但没保存任务，仍会重复；
- 保存 `(task, action, outcome)` 三元组后多样性最好；
- 自主任务集中在计算器、密码生成器、闰年/素数/回文/温度转换等训练分布模板；
- 人类关于新颖性的反馈若未主动写入长期记忆，很快失效。

[定性结果](https://arxiv.org/html/2510.14548#S3)

作者的结论与 Luna 的表现高度一致：预训练 instruction-following LLM 被优化成单次任务解决器，并没有被训练去平衡新颖性和连续性、逐步建设抽象兴趣或判断什么值得长期保存。[结论](https://arxiv.org/html/2510.14548#S4)

**对 Luna 的启示。**当前现象不是偶然 prompt bug。让一个 task solver 自己生成 tasks，最自然的退化就是“给自己派一串熟悉小活，再宣布做完”。要改变组织单位，而不是把“主动一点”写得更重。

### 2.9 AI Picbreeder：最接近“没有目标的创造”，也直接展示单一人格的局部循环

**项目机制。**2026 年 Sakana AI、MIT 和 NYU 用 VLM Agent 复现 Picbreeder。Agent 从共享图片 archive 选择 parent、经过随机突变迭代、发布自己喜欢的作品并评价别人的作品；系统没有目标图，也没有固定“进步”定义。[论文](https://arxiv.org/html/2605.23908)、[作者官方介绍](https://sakana.ai/picbreeder-ai/)

**实际结果。**相较人类，VLM 会反复选择相似 parent、做更小的概念跳跃，倾向细化已有概念而不是放弃它去寻找意外；人类更擅长把偶然形态认成值得追踪的 stepping stone。增加多样人格能提高语义覆盖和谱系平衡，但少量固定人格会各自困在偏好子区域；例如偏爱“干燥陶土红”的 Agent 产生大量近乎相同色块。大量人格又会产生高频、不可解释、可能对指标形成对抗的图像。[作者总结](https://sakana.ai/picbreeder-ai/)、[论文 §5–6](https://arxiv.org/html/2605.23908#S5)

另一个与 `rest` 极其相似的发现是：作者最初让 Agent 自由决定何时发布，Agent 会快速发布并结束 session，于是作者把 session 固定为 20 代。[论文 §3.3](https://arxiv.org/html/2605.23908#S3.SS3)

**对 Luna 的启示。**同一个长上下文和同一种人格会形成吸引子。无需引入多个并行 Agent，但每个探索 episode 应切换“观察视角”，候选生成可使用短、新鲜上下文；同时，Runtime 要拥有最低探索深度和结束边界，不能让模型用一次 `inbox` 或一篇总结快速完成 episode。

### 2.10 SIMA 与 Cradle：更广的行动空间会增强能力，但不会自动产生自己的方向

SIMA 通过屏幕、键鼠和自然语言指令在多种 3D 游戏里完成约 10 秒的基础任务；官方报告明确说无语言指令的控制模型会作出适当但漫无目的的行为，例如习惯性采集资源。[SIMA 官方报告](https://deepmind.google/blog/sima-generalist-ai-agent-for-3d-virtual-environments/)

Cradle 统一使用截图和键鼠，组合 information gathering、self-reflection、task inference、skill curation、planning 和 memory，在多个游戏和桌面软件里完成长任务。[Cradle 论文](https://proceedings.mlr.press/v267/tan25h.html)、[官方仓库](https://github.com/BAAI-Agents/Cradle)

它们解决的是“给定方向后能在更多世界行动”，不是“为什么选择这个方向”。给 Luna 更多浏览器、网站和创作工具，不会自动让她有兴趣；如果选题机制仍是 task completion，她只会拥有更多打卡方式。

## 三、跨项目共同规律

### 3.1 创造性来自一个选择生态，不来自一句人格设定

成功系统至少有四部分：

```text
变化来源          候选选择              现实反馈            留存与迁移
环境/突变/文献 -> 新颖 + 有趣 + 可学 -> 执行/实验/反证 -> archive/skill/reflection
```

少一个都会退化：

- 没有变化来源：围绕最近聊天和旧任务循环；
- 没有选择压力：随机刷世界，落入 noisy TV；
- 没有现实反馈：靠 Notebook 自证完成；
- 没有留存：每次醒来重新发明同一问题；
- 只留存“成功总结”：把过去轨迹固化成身份和打卡模板。

### 3.2 开放式目标不应被表示成 backlog

任务清单天然要求“完成、打勾、清空”。当清空成为可见状态，instruction-tuned 模型很容易把生命组织成：

```text
列任务 -> 完成任务 -> 写总结 -> 宣布今天结束 -> 等别人派新任务
```

更合适的持久对象是 **frontier（问题前沿）**：它可以被深化、重写、分叉、冷却和重新激活，不要求清零。任务只是在验证某个 frontier 时临时产生的一步动作。

### 3.3 新颖性必须针对“行为语义或认识变化”，不能针对工具调用

`inbox` 参数变了、Notebook 标题变了、文章主题变了，不代表行为模式变了。Novelty Search 比较 behavioral descriptor；AI Picbreeder 比较视觉/语义覆盖和谱系；AI Scientist 用既有文献和实验检查。

对应到 Luna：

- 工具级 novelty key 只能防完全相同参数；
- frontier novelty 应比较“问题、来源对象、提出的联系、证据结论”；
- 进展应比较“已知状态前后发生了什么变化”；
- 写一条描述变化的 Note 不是变化本身。

### 3.4 单一路径会形成吸引子，随机乱跳也不是创造力

Luna 目前的吸引子是：近期任务、zzz 反馈、群 @、写作产量、停止总结。AI Picbreeder 则显示固定偏好 Agent 会占据自己的小区域。

解决办法不是每次随机换题，而是兼顾两种压力：

- **continuity pressure**：有新证据、仍在学习的 frontier 获得回访机会；
- **diversity pressure**：长期没产生认识变化、重复同一形式时切换来源和视角。

### 3.5 “休息”不是创造力的反面，模型控制生命周期才是问题

创造需要停顿，但停顿不应由模型通过反复说明“已经完成所有有价值的事”来延长。开放式项目通常让 harness 控制 episode、预算、重试和切换；模型只在 episode 内选择动作。

对 Luna 应区分：

- `PARKED`：Runtime 没有在调用模型，等待事件或下一次自主 tick；
- `COOLING`：一个 frontier 暂时没有可做的探查，未来遇到特定线索可返回；
- `ACTIVE`：正在形成问题或获取证据；
- `STUCK`：连续探查没有信息增益，Runtime 要求换 frontier 或 PARKED。

模型可以表达“这个方向先放下”，但不能用 `rest` 自己实现无限生命周期循环。

## 四、为什么当前 Luna 像打卡上班

以下是基于本仓库当前实现的工程判断。

### 4.1 `autonomous_life` 在语义上把世界收缩到了最近工作

当前 [`autonomous_life.md`](../agent-skills/autonomous_life.md)要求按以下顺序找方向：最近上下文、Notebook 已有主线、稳定兴趣；候选不成立便立即 `rest`，并明确反对宽泛浏览 HN/Reddit。这个设计原本用于防机械刷站，但结果是几乎切断外部陌生刺激。

它还把文章、Notebook、市场观察、熟人反馈等组织成工作流，很容易被模型解释为职业任务。结尾的“一次方向搜索后仍无牵引力就 rest”提供了低成本结束准则。

### 4.2 当前 autonomy tick 的三种方向有两种仍是 backlog

[`AUTONOMY_DISCOVERY_DIRECTIONS`](../../src/agent/bot-loop-agent.ts)依次是：

1. 未完成承诺；
2. 已有 artifact；
3. 有界好奇。

前两项继续强化“完成别人交代的事”和“维护已有产出”，只有第三项允许接触世界。即使轮换公平，Luna 也会把大多数自主唤醒理解成清 backlog。

### 4.3 探索门控信任所有工具自报的 `progress`

当前 `resolveToolControl()` 只要 outcome 的 novelty key 未重复且 `progress: true`，就设置 `madeProgress`；`runOnce()` 随后在一次 autonomy discovery round 有 progress 时结束探索门控。

这解释了实况中的绕过：一次新 `inbox` 读取或 `conversation close` 只要工具层自称 progress，就足以解除“不得 rest”，尽管它没有获得与自主问题相关的新外部证据。

### 4.4 探索状态是进程内布尔值，不足以表达长期兴趣

`autonomyDiscoveryActive`、direction index 和 no-progress rounds 都是 BotLoop 内存变量。它们适合做短期循环保护，但重启后无法恢复“刚才在探索什么、为什么、得到了什么”。canonical ledger 虽保存 tick 和工具轨迹，Runtime 目前没有从它投影出 frontier 状态。

### 4.5 当前行为与一手研究中的默认失败完全一致

Luna 的“完成具体任务很强，开放时间重复熟悉动作；prompt 越要求主动，越围绕固定工具循环；长期记忆写结果不写问题；依赖用户反馈选择方向”与《LLM Agents Beyond Utility》的观察几乎逐项吻合。

所以不能期待再加一句“世界很大，去做自己想做的事”就解决。模型会把它翻译成另一个指令任务，并寻找最便宜的完成证据。

### 4.6 system prompt 与 psychologist 还在同时施加相反压力

当前 [`system.md`](../../prompts/system/system.md)一方面要求没有真实牵引力、已机械重复时调用 `rest`；另一方面又要求模型在准备停下可推进方向时调用 psychologist。现有 [`psychologist.md`](../../prompts/tools/psychologist.md)没有判断“是否仍有可推进方向”的能力，而是把“休息、今天到此、停下、放空”等文本模式统一改写成“继续 High”“别停”。

这会形成一个反常反馈：Luna 越想合法休息，越需要写一篇强调“所有有价值的事已经完成”的停止辩护，才能证明自己不属于 psychologist 要翻转的消极模式；一旦休息又被 Runtime 拒绝，这些辩护便反复进入上下文并成为下一轮模仿模板。psychologist 不应充当永久 anti-rest controller；是否存在可推进 frontier 应由 Runtime 的证据状态判断，它最多保留为用户主动请求的反思工具或仅处理有明确未完成 obligation 的窄场景。

## 五、推荐方案：Surprise-led Frontier Loop

这个方案的目标不是让 Luna 24 小时持续工作，而是让每次自主醒来都更可能产生自己的问题。

### 5.1 状态机

```text
PARKED
  | 外部事件：正常处理
  | autonomy tick：给一个外部接触槽位 + 观察视角
  v
EXPOSURE
  接触至少一个新的外部对象；inbox/close/旧 Notebook 不算
  v
QUESTION
  提出一个具体、可被下一步证据改变的问题或猜想
  v
PROBE
  做一次最有区分力的只读探查；得到外部证据或真实状态变化
  v
UPDATE
  写清：原先怎么想、看到什么、现在改变了什么
  | 有意外/仍可学 -> 深入或分叉同一 frontier
  | 没信息增益   -> 冷却 frontier，换来源或 PARKED
  v
PARKED / NEXT PROBE
```

这不是一个完整 Goal 平台。一次只允许一个 active frontier；候选问题在选中后才进入 canonical 时间线，未选候选不形成 backlog。

### 5.2 外部接触：先让世界进入，再让模型找兴趣

自主 tick 不应优先提示“检查承诺”和“检查已有文件”，而应给一个 **source lane**。可以用确定性轮换而不是随机服务：

1. 新研究/开源项目；
2. 技术与互联网文化中的具体争论；
3. 艺术、小说、影像或历史材料；
4. 市场/产业中的反常事实；
5. 一个与近期主题语义距离较远的领域；
6. 回到此前仍有信息增益的 frontier。

每次只需要接触一个具体对象，不要求刷完整 feed。来源内容通过已有 `external_research`、`browser` 等只读工具进入 canonical tool result。

“陌生”不能只由模型声称。Runtime 可用最近 N 个来源 URL、对象指纹和 frontier 问题做轻量去重；选择 lane 的 index 或随机 seed 必须先写入 tick，确保 replay 不依赖未来随机结果。

### 5.3 问题形成：用短暂视角轮换代替永久多 Agent

AI Picbreeder 表明多样偏好能扩大覆盖，但仓库不需要第二 Agent。单一 BotLoop 可在不同 episode 轮换一个临时 lens：

| Lens | 只问什么 |
| --- | --- |
| naturalist | 这里实际发生了什么，哪个细节与常识不符？ |
| skeptic | 哪个默认解释最可能是错的，怎样找反证？ |
| connector | 它与一个看似无关的旧观察有什么可检验联系？ |
| maker | 能否做一个很小的实验、图、原型或改写来暴露新性质？ |
| historian | 这个现象从哪里来，今天的形态漏掉了什么路径？ |
| outsider | 如果不围绕 zzz、群聊和当前项目，我会注意到什么？ |

Lens 不是 persona，也不是长期兴趣标签；它只改变本次候选生成的观察角度，防止一条人格 prompt 形成长期吸引子。

每次最多生成三个候选问题，随后丢弃未选项。合格问题应满足：

- 指向一个已接触的具体对象；
- 不是用户任务或最近总结的改写；
- 至少存在一个可以立即执行的只读 probe；
- probe 的两种可能结果会改变判断；
- 与近期 frontier 不只是换名重复；
- 不需要未授权外部副作用。

### 5.4 选择：不暴露单一“创造力分数”

借鉴 OMNI、learning progress 和 novelty search，Runtime/离线观察面可记录四个诊断维度：

- semantic novelty：与近期 frontier 的语义距离；
- interestingness：是否可能对人类或 Luna 的长期理解有意义；
- learnability：当前能力能否在一两个 probe 内减少不确定；
- continuity：它是否延续了仍在产生新证据的旧 frontier。

但不要把加权总分展示给 Luna，也不要要求“每项至少 8 分”。模型应只看到资格条件，合格后由它选择最想追的一项。否则它会优化提案文案和自评分。

### 5.5 进展：在探索 episode 内使用独立的 evidence gate

普通工作仍可沿用工具自身 `outcome.progress`；**autonomy discovery 不能复用它。**建议增加一个只在 discovery 生效的语义分类：

| 动作/结果 | 是否可解除探索门控 | 原因 |
| --- | --- | --- |
| 读到此前未见的外部原文、数据、代码或作品 | 可以，若与当前问题相关 | 新外部证据 |
| 运行实验得到新结果、artifact 有可验证 diff | 可以 | 可观察状态变化 |
| 因证据修正问题、排除一个解释 | 可以，但证据必须已在 ledger | 认识发生可追溯变化 |
| `inbox` 仅观察无 @ 的普通群聊 | 不可以 | 没有探索对象或认识变化 |
| `conversation close` | 不可以 | 控制状态清理 |
| `schedule list`、`help`、`skill load` | 不可以 | 元操作 |
| Notebook/Memory 写总结 | 不可以 | 对变化的描述，不是变化本身 |
| 新建同型文章、换标题重写停止总结 | 不可以 | 产量代理 |
| `rest` | discovery 期间不可用 | 生命周期不由模型提前结束 |

这里不需要一个通用 AI progress judge。第一版用工具/动作 allowlist 和“新来源指纹”即可，保守地把不确定项判为不解除门控。错判只会让 episode 在两轮无进展后 PARKED，不会导致无限强制行动。

### 5.6 兴趣留存：记录 frontier，不记录“今天任务完成”

一个最小 frontier 记录可以是：

```json
{
  "question": "为什么这个项目在删掉目标函数后反而出现更多不同解法？",
  "seedEvidence": "canonical tool result / URL / artifact hash",
  "surprise": "原先以为没有目标只会随机游走",
  "lastProbe": "比较 Novelty Search 与 POET 的选择机制",
  "update": "新颖性需要 archive 和最低可解标准，不能只是随机",
  "nextProbe": "找一个纯新颖性产生噪声的反例",
  "state": "active | cooling | dropped"
}
```

这条记录不必成为数据库 Goal。首版可以由 Runtime 把结构化 marker 作为普通 user-role message append 到唯一 canonical ledger；外部证据仍是普通 tool result。projection 从最新 marker 和后续工具结果确定当前 phase，保持 replay 确定性。若暂时不增加 marker，至少应把 `(question, probe, evidence/outcome)` 同时写入现有 Notebook，而不是只写结果；Notebook 写入本身仍不算 progress。

进入稳定 Memory 的不是“我喜欢技术/写作”，而应是跨多个 episode 重复出现的模式，例如：“三次在不同项目里都主动追踪无目标搜索为什么能产生踏脚石，并在看到反例后仍回来”。这比一次自我宣言更接近兴趣。

### 5.7 休息和自唤醒

建议把模型可见 `rest` 从探索生命周期控制降级为人格表达：

- 没有 active frontier 时，Runtime 直接 PARKED，不要求模型调用 `rest`；
- autonomy tick 由宿主 timer 产生，并作为 canonical message append；
- discovery episode 至少完成一次真实外部 exposure 和一个 probe，或达到两轮无进展熔断；
- episode 结束后由 Runtime 等待，不让模型用 Schedule 建立轮询；
- 普通外部消息、@、后台完成仍立即唤醒并优先处理；普通群闲聊不自动变成任务；
- 进程重启后从 canonical tick/frontier marker 恢复 phase，不能通过重启清掉门控。

可先保留当前 30 分钟最大等待，不急着设计复杂自适应 cadence。获得行为数据后再考虑：active frontier 在有明确下一 probe 时短间隔，连续 dry episode 时逐步拉长；每次 dry 都切换 source lane，不能再次“检查 zzz/@”。

重要的是：**唤醒频率不产生创造力。**一分钟唤醒一次只会更快重复；一个好的外部 seed 和 evidence gate 比更多轮次重要。

### 5.8 防止奖励投机和机械循环

1. 不向模型显示“创造力积分”、文章数、工具数、在线时长等总分。
2. Notebook、Memory、close、list、休息理由不解除 discovery gate。
3. 同一个 frontier 的 probe 语义重复两次即 cooling，不允许仅改参数/标题重试。
4. 每个 episode 有固定 tool-call/时间上限，边界由 Runtime 持有。
5. 外部写操作、主动发消息、发布文章、模拟交易继续遵循各工具原有授权；自主探索默认只读。
6. 分享不是完成条件。只有确实产生一个想和某个相关对象讨论的具体问题时，才进入现有 conversation open/send_message 流程。
7. 不把用户普通闲聊、未 @ 群消息当作“世界给出的任务”；它可以是观察素材，但不要求回复。

## 六、最适合 qq-bot-v2 的最小实现顺序

### Slice 1：先修当前绕过，不建设新平台

只沿用现有单一 `BotLoopAgent`、`LoopPolicy`、EventQueue 和 canonical ledger：

1. 把 autonomy direction 从“未完成承诺 / 已有 artifact / 有界好奇”改成“外部 source lane + 临时 lens”；用户事件另走现有 attention/continuation，不混入自主 tick。
2. 重写 `autonomous_life`：删除“一次从最近上下文搜索，没有牵引力就 rest”的核心组织方式；改成先接触具体外部对象，再形成问题。
3. 在 discovery executor 外再加一层 `qualifiesAutonomyProgress()`，明确排除 inbox observe、close、Notebook/Memory、Schedule list、help/skill load。
4. 保持 `rest_unavailable_during_autonomy_discovery`，但两轮无合格进展后直接由 Runtime PARKED，避免恢复旧的强制忙碌。
5. 在 tick 中记录 source lane、lens 和 sequence/index；这些都是 canonical 输入，replay 不依赖内存中的随机选择。
6. 从常驻自主控制中移除 psychologist 的“休息/停下必翻转”职责；只有 Runtime 已知存在未完成 obligation 时才允许做窄纠偏，不能靠停止文本本身判断。

这一 slice 不需要 schema、第二队列、第二 Agent、持久 Goal、embedding 服务或新后台进程。

### Slice 2：有数据后再加一个浅 frontier marker

只有 Slice 1 证明 Luna 能形成具体问题但跨唤醒丢失时，再新增一个受控 canonical marker，保存 `(question, seed, probe, evidence, state)`。它应是 ledger 的普通受控 message，而不是 side table truth；projection 必须纯函数解释它。

### Slice 3：最后再考虑语义去重和动态 cadence

如果 URL/动作 allowlist 仍无法识别“换标题的同义重复”，再增加低成本语义指纹或离线 judge。若 30 分钟固定 tick 确实造成过密或过疏，再根据 active/dry frontier 调整等待时间。不要先上复杂评分、向量库或多 Agent。

## 七、如何判断新方案是真的更有创造力

建议做 48–72 小时只读日志评估，不把指标写入她的 prompt：

| 指标 | 希望看到的变化 |
| --- | --- |
| self-originated question rate | 自主 episode 中出现非用户改写问题 |
| evidence-bearing episode rate | 至少一个新外部来源/实验结果改变了问题 |
| semantic repetition | 同义 frontier、同类工具序列明显下降 |
| frontier return | 隔多个 episode 因新线索回到旧问题，而非固定轮询 |
| branch quality | 有证据地深入/分叉/放下，不是换标题 |
| passive-work ratio | inbox/close/list/总结占自主 episode 的比例下降 |
| rest chain | `醒来 -> inbox -> close -> rest` 链消失 |
| unsolicited social side effects | 继续为零或保持在既有授权范围 |

人工抽样时重点问四个问题：

1. 这个问题是谁提出的，能否追溯到一个具体外部 seed？
2. 如果没有那条新证据，她还会写出同样的内容吗？
3. 新证据是否真的改变了问题、判断或作品？
4. 她是在追兴趣，还是在完成“自主探索”这项新 KPI？

不要用文章数、Notebook 数、token 消耗或连续运行时长做主指标。AI Scientist 和 AI Picbreeder 都说明，单一可见指标会诱发投机或噪声。

## 八、保留、调整还是 revert

**建议：调整，不直接 revert。**

- 应保留：定时自主 tick、discovery 期间禁用 `rest`、两轮无进展后 Runtime 等待、外部事件即时打断、单一 serial BotLoop。
- 应调整：tick 的方向来源、探索 progress 的定义、状态从纯进程内布尔值到 canonical 可恢复线索、`autonomous_life` 的“近期工作优先 + 一次搜索后休息”，以及 psychologist 对所有休息/停止文本的一刀切翻转。
- 不应恢复：强制每轮调用工具、rest 额度耗尽后无限寻找替代工具、用 Notebook/close/schedule list 证明自己没偷懒。
- 暂不需要：第二 Agent、并行 population、Goal 平台、新数据库表、复杂 reward model、持续向量评分服务。

如果最小 Slice 经过 72 小时仍只把外部 exposure 变成新的打卡模板，再考虑更根本的限制：当前 instruction-tuned 模型可能没有被训练出开放式 goal-generation 策略。《LLM Agents Beyond Utility》的作者也把直接训练 memory management、productive exploration 和 abstract-goal selection 视为下一步，而不是声称 scaffold 已解决问题。届时真正的替代可能是专门训练/选择模型或分离 candidate generator，但现在还没有证据需要扩成第二 Agent。

## 主要一手来源

- Park et al., [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/html/2304.03442), UIST 2023；[官方代码](https://github.com/joonspk-research/generative_agents)。
- Wang et al., [Voyager: An Open-Ended Embodied Agent with Large Language Models](https://arxiv.org/html/2305.16291), 2023；[项目网站与代码入口](https://voyager.minedojo.org/)。
- Colas et al., [Augmenting Autotelic Agents with Large Language Models](https://proceedings.mlr.press/v232/colas23a.html), CoLLAs 2023。
- Zhang et al., [OMNI: Open-endedness via Models of human Notions of Interestingness](https://arxiv.org/html/2306.01711), 2023/2024。
- Pathak et al., [Curiosity-driven Exploration by Self-supervised Prediction](https://arxiv.org/html/1705.05363), ICML 2017。
- Pathak et al., [Self-Supervised Exploration via Disagreement](https://arxiv.org/html/1906.04161), ICML 2019。
- Sekar et al., [Planning to Explore via Self-Supervised World Models](https://arxiv.org/html/2005.05960), ICML 2020。
- Lehman & Stanley, [Abandoning Objectives: Evolution Through the Search for Novelty Alone](https://direct.mit.edu/evco/article/19/2/189/985/Abandoning-Objectives-Evolution-Through-the-Search), Evolutionary Computation 2011。
- Wang et al., [Paired Open-Ended Trailblazer (POET)](https://arxiv.org/html/1901.01753), 2019；[Uber AI 官方介绍](https://www.uber.com/us/en/blog/poet-open-ended-deep-learning/)。
- Lu et al., [The AI Scientist](https://arxiv.org/html/2408.06292), 2024；[Sakana AI 官方介绍与代码入口](https://sakana.ai/ai-scientist/)。
- Yamada et al., [The AI Scientist-v2](https://arxiv.org/html/2504.08066), 2025；[官方代码](https://github.com/SakanaAI/AI-Scientist-v2)。
- Nachkov et al., [LLM Agents Beyond Utility: An Open-Ended Perspective](https://arxiv.org/html/2510.14548), NeurIPS 2025 CogInterp workshop。
- Kumar et al., [In Search of the Ingredients of Open-Endedness: Replicating Picbreeder with Large Vision-Language Models](https://arxiv.org/html/2605.23908), GECCO 2026；[Sakana AI 官方总结](https://sakana.ai/picbreeder-ai/)。
- Google DeepMind, [A generalist AI agent for 3D virtual environments (SIMA)](https://deepmind.google/blog/sima-generalist-ai-agent-for-3d-virtual-environments/), 2024。
- Tan et al., [Cradle: Empowering Foundation Agents towards General Computer Control](https://proceedings.mlr.press/v267/tan25h.html), ICML 2025；[官方代码](https://github.com/BAAI-Agents/Cradle)。
