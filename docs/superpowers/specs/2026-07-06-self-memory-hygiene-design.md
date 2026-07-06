# Self 记忆自主整理设计

## 背景

`data/agent-workspace/memory/self/` 在一天内产生了 37 个 Markdown 文件，约 31 KB。大量文件重复记录夜间循环、休息规则和当天总结。Agent 已经写出 `2026-07-06-全天终极精简版.md`，但当前 `memory` 只有 `write`、`search`、`read`，无法删除被替代的旧文件。

## 目标

- 让 Agent 能查看某个 scope 下有哪些记忆文件。
- 让 Agent 能永久删除明确指定的记忆文件。
- 通过提示词引导 Agent 在自己觉得记忆重复、过时或难检索时主动整理。
- 保持操作有界、路径安全，不引入固定周期、数量阈值或进程内维护状态。

## 非目标

- 不做回收站、归档或恢复功能。
- 不做 cron、每日任务或 runtime 强制触发。
- 不自动判断哪些内容应合并，也不由代码自动改写记忆正文。
- 不限制 Agent 对普通 workspace 文件的使用。

## Memory API

### `action=list`

输入：

- `scope`：可选，限定 `self`、`person`、`group` 或 `topic`。
- `limit`：可选，1–100，默认 50。

输出按 `updatedAt` 倒序返回文件元数据：

- `file`
- `scope`
- `title`
- `updatedAt`
- `sizeBytes`

结果包含 `truncated`，避免文件很多时把无界内容送进 AgentContext。`list` 不读取或返回正文。

### `action=delete`

输入：

- `files`：1–50 个明确的 `.md` 相对路径。

行为：

- 对每个路径复用 `memory-store` 的安全路径解析，真实路径必须位于 `data/agent-workspace/memory/`。
- 永久删除文件，不创建备份或回收站副本。
- 不存在的文件作为 `missing` 返回，其他文件仍继续处理，使重复调用保持可恢复。
- 输出 `deleted`、`missing` 和 `failed` 三组路径；不返回文件正文。

Zod schema 负责输入形状和批量上限，`memory-store` 负责不可绕过的路径边界。不新增 tool policy hook。

## Agent 行为

在 `prompts/bot-system.md` 的自主生活指引中加入一条短提示：当长期记忆开始重复、过时或难检索时，可以主动整理，但不要为了整理而反复生成总结。

在 `docs/agent-skills/memory_hygiene.md` 中补充完整流程：

1. 自己感觉记忆变乱时再整理，不按固定时间机械执行。
2. 用 `memory list/search/read` 确认重复内容。
3. 先写好要保留的精简版本。
4. 确认有价值的信息已保留，再用 `memory delete` 批量删除被替代文件。
5. 不把短期情绪、普通日记或同一结论的反复重述继续写入长期记忆。

## 当前数据清理

实现并验证删除能力后，保留：

- `memory/self/2026-07-06-全天终极精简版.md`

永久删除当前其余 `memory/self/*.md` 文件。清理前再次列出目录，避免删除实现期间新产生的文件；若出现新文件，先检查是否晚于精简版且包含未被覆盖的信息。

## 错误处理与审计

- 非 `.md`、绝对路径、`..` 逃逸路径由 store 拒绝。
- 单个文件删除失败不终止整个批次，失败原因进入 `failed`。
- `memory` 工具日志记录删除数量和文件路径，不记录正文。
- `delete` 作为有副作用 action 纳入现有 tool-call side-effect 分类。

## 验证

- `memory-store` 测试：列表排序、scope 过滤、结果截断、永久删除、不存在文件、批量部分失败、路径逃逸。
- `memory` tool 测试：`list`/`delete` schema 和结构化结果。
- tool-call 日志测试：`memory action=delete` 被识别为副作用。
- prompt/skill 测试：常驻提示词只增加短指引，详细整理流程仍按需披露。
- 运行 focused tests、`pnpm typecheck` 和 `pnpm repo-check`。
