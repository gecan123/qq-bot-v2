# 空闲自驱动强化设计

## 背景

`233a9abb` 已经把空闲主动引导放在 system prompt 和 `pause action=wait` 的 idle tool result 里。继续沿用这个层次，不新增调度器或新工具，避免改变 replay、compaction 和事件注入模型。

## 设计

- 空闲不是停机，而是自由活动窗口。Luna 应先从外界内容、上下文、journal、已有工具和代码自审里找一个自己真想做的小任务。
- 主动开口必须有真实锚点：刚看到的内容、刚整理出的想法、刚发现的能力缺口，或明确的工具/事件需求。
- 如果真的卡住、无聊、或连续觉得能力不足，才偶尔私聊创作者提需求。需求应说清楚“想做什么、现在缺什么、建议加什么能力”，不要频繁发送泛泛愿望。
- 做完一轮后可以继续深读、记录 journal、自然开话题，或 `pause action=wait` 继续等。

## 验证

- 更新 `src/agent/tools/wait.test.ts`，锁定 idle tool result 的行为关键词。
- 运行 focused wait test。
