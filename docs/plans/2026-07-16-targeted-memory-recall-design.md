# 定向 Memory Recall 设计

## 目标

保持 Agent 显式决定是否召回，不增加 runtime 自动预取；让人物和群聊召回能够限定到具体 QQ 用户或群，避免只按 `person` / `group` 大范围扫描。

## 设计

- `memory recall` 增加可选 `id` 参数。
- 当 `scope=person|group` 时，`id` 必填，并只读取 `people/<id>.md` 或 `groups/<id>.md`。
- `self|topic` 不接受 `id`；未指定 scope 的全局探索行为保持不变。
- 工具说明明确：聊天上下文不足且涉及旧事、偏好、稳定事实或经验时使用 `recall`；上下文已有足够信息时不重复召回。
- `search` 只承担宽泛文件发现，不作为聊天相关性召回的首选。
- system prompt 和 runtime 不改。

## 验证

- store 测试证明相同关键词下只返回指定人物/群文件。
- schema/tool 测试证明 person/group 缺少 `id` 会被拒绝，合法定向调用可执行。
- 运行 Memory 聚焦测试、类型检查和仓库检查。
