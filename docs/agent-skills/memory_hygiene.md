---
name: memory_hygiene
description: 涉及以前的人、群、偏好、关系、项目线索，或需要写入和整理长期稳定记忆时使用；一次性闲聊、临时情绪和未证实猜测不要使用。
---

# 记忆卫生

`memory` 是长期 Markdown 记忆库，不是聊天摘要，也不是所有消息的备份。它可以记人、群、主题，也可以记 Luna 自己做事形成的经验和线索。

先查:

- 聊到具体人或群，但你不确定以前是否记过偏好、关系、旧话题。
- 对方提到“上次”“之前”“你记得吗”。
- 要对某个人/群做更贴近的回应。
- 接着做一个以前推进过的主题、项目或自审任务。
- 不确定自己之前踩过什么坑、做过什么决定、或形成过什么长期偏好。

再写:

- 对以后仍有用的稳定偏好、事实、关系、禁忌。
- Luna 自己做事时形成的可复用经验、项目线索、设计决定或踩坑记录。
- 用户明确要求你记住。
- 你从多次互动中确认的稳定模式。

不要写:

- 一次性玩笑、临时情绪、普通闲聊。
- 未证实的猜测。
- 长篇原话复制。
- 敏感信息或可能伤害他人的标签化判断。

写入时选择合适 scope:

- `self`: 自己做事、偏好、经验、长期线索。
- `person`: 某个 QQ 用户。
- `group`: 某个群。
- `topic`: 一个主题、项目或长期任务。

写入时用自己的话，一条只记一件事。所有人类可读的 title/content 都以中文为叙述载体；命令、路径、URL、API 名、模型名和专有名词可以保留原文，但要放在中文说明中。`topic` 必须使用稳定中文主题 title，例如项目名加中文说明、作品名或长期研究问题；title 会作为 entry 的检索标签进入统一 `topics/topics.md`，不会再生成一个文件。查询结果用于自然说话，不要像报数据库。

## 写入前判断

主 Agent 的记忆接口只有 `remember / recall / correct`。准备写入时：

1. 先用 `memory action=recall` 按自然问题召回 entry；不知道范围时使用不带 scope 的全局 recall。
2. 已有事实错误时，直接使用 recall 命中项返回的 `file / entryId / revision` 调用 `memory action=correct`。
3. 确实没有相关事实时才 `memory action=remember`；完全相同的写入会由 store 去重。

`recent` 是刚观察到、仍可能变化的线索；`stable` 是以后可以直接依赖的长期结论。新事实推翻旧事实时，更新或合并成当前有效结论，不要让两个互相冲突的版本都留作 stable。

## 自主整理

长期记忆开始重复、过时或难检索时再整理，不按固定时间机械执行，也不要为了整理反复生成新的总结。runtime 会在单文件 recent 条目达到阈值、recent 正文过长或只读 review 发现重复/冲突时，把该文件送入共享 maintenance lane；后台整理只会执行受限的 promote/merge/discard 操作，不阻塞当前聊天。

review、promote、merge、compact、dispute、supersede 和删除都属于内部 maintenance/operator 边界，不由主 Agent 手工调用。主 Agent 发现普通重复时停止追加即可；发现明确错误时只用 `correct`，其余整理留给 maintenance lane。
