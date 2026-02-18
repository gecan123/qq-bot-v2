# Memory System Design

Date: 2026-02-19

## Goal

让 bot 对群聊和群成员形成持续演进的"记忆"，具体包括：
- **群印象**：群风格、常见话题、整体氛围
- **用户画像**：个人性格、兴趣、说话方式 + 代表性发言样本（few-shot）

本期不含 context 注入，记忆生成后由人工查库验收质量。

---

## DB Schema

### `group_memory`

```prisma
model GroupMemory {
  id            Int      @id @default(autoincrement())
  groupId       BigInt   @unique @map("group_id")
  groupName     String?  @map("group_name") @db.VarChar(255)
  summary       String   @map("summary") @db.Text
  lastMessageId BigInt   @map("last_message_id")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@map("group_memory")
}
```

### `user_memory`

```prisma
model UserMemory {
  id                  Int      @id @default(autoincrement())
  groupId             BigInt   @map("group_id")
  groupName           String?  @map("group_name") @db.VarChar(255)
  senderId            BigInt   @map("sender_id")
  senderNickname      String?  @map("sender_nickname") @db.VarChar(100)
  senderGroupNickname String?  @map("sender_group_nickname") @db.VarChar(100)
  profile             String   @map("profile") @db.Text
  examples            String[] @map("examples")
  updatedAt           DateTime @updatedAt @map("updated_at")

  @@unique([groupId, senderId])
  @@map("user_memory")
}
```

---

## Background Job（`src/jobs/refresh-memory.ts`）

### 触发条件（满足其一）

- 距上次更新超过 N 小时（`MEMORY_JOB_INTERVAL_HOURS`，默认 4）
- 或新消息数 ≥ 阈值（`MEMORY_JOB_MIN_MESSAGES`，默认 100）

### 每次运行逻辑

```
for 每个监控中的群 (GROUP_IDS):
  1. 读取 GroupMemory.lastMessageId（无记录则从 0 开始）
  2. 拉取 lastMessageId 之后的增量消息
  3. 如果增量消息 < 20 条 → 跳过本群
  4. 调 LLM 更新群摘要（旧摘要 + 新消息 → 新摘要）
  5. 按 senderId 分组，识别增量消息中的活跃用户
  6. for 每个活跃用户:
       读取现有 UserMemory（可能为空）
       调 LLM 更新用户画像 + 挑选代表性发言样本
       upsert UserMemory
  7. upsert GroupMemory，更新 lastMessageId
```

### LLM Prompt 结构

**群摘要更新：**
```
你之前对这个群的了解：
{旧摘要，首次为空}

以下是该群最近的新消息：
{增量消息，格式：[时间] 昵称: 内容}

请更新你对这个群的整体印象，包括：群的氛围风格、常见话题、活跃规律。
保留旧印象中仍然成立的部分，补充新观察，修正已过时的描述。
用中文简洁描述，200字以内。
```

**用户画像更新：**
```
你之前对 {昵称} 的了解：
{旧画像，首次为空}

以下是他/她最近说的话：
{该用户的增量消息}

请更新你对他/她的印象（性格、兴趣、说话风格），并从上面的消息中
挑选 3-5 句最能代表他/她说话方式的原话作为例句。
用中文描述，印象部分 100 字以内。

返回 JSON：
{
  "profile": "...",
  "examples": ["...", "...", "..."]
}
```

---

## 配置项

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMORY_JOB_INTERVAL_HOURS` | `4` | 定时触发间隔（小时） |
| `MEMORY_JOB_MIN_MESSAGES` | `100` | 触发所需最少新消息数 |
| `MEMORY_JOB_SKIP_THRESHOLD` | `20` | 单群跳过阈值（增量消息不足时跳过） |

---

## 验收方式

记忆生成后直接查库：

```sql
SELECT group_name, summary, updated_at FROM group_memory;
SELECT group_name, sender_group_nickname, profile, examples, updated_at FROM user_memory;
```

人工判断摘要质量后，再决定是否进行 context 注入。

---

## 不在本期范围内

- Context 注入（`context-builder.ts` 改造）
- 记忆检索 / 语义搜索
- 前端查看界面
