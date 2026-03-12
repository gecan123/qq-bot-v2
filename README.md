# qq-bot-v2

一个基于 NapCat + Node.js + Prisma + PostgreSQL 的 QQ 群聊机器人项目。

当前项目主要做三件事：

- 监听指定 QQ 群消息
- 持久化消息、媒体和群记忆
- 在可用时接入 Gemini 能力，生成图片描述、摘要和自动回复

## 功能概览

- 监听指定群消息并写入 PostgreSQL
- 启动后自动补拉最近一批群历史消息
- 缓存图片/媒体引用，支持媒体描述
- 基于 Redis 队列处理异步任务
- 定时刷新群记忆和用户记忆
- 可选启用 Gemini 能力用于总结、描述和回复

## 环境要求

- Node.js 20+
- pnpm 10+
- PostgreSQL
- Redis
- NapCat，并开启 WebSocket

## 安装

```bash
pnpm install
```

## 环境变量

先复制一份环境变量模板：

```bash
cp .env.example .env
```

然后按实际环境修改 `.env`：

```env
# PostgreSQL
DATABASE_URL=postgresql://qq_user:qq_password@127.0.0.1:5432/qq_bot_v2

# Redis
REDIS_URL=redis://127.0.0.1:6379

# NapCat
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_ACCESS_TOKEN=your_token_here

# 监听的群号，多个用逗号分隔
GROUP_IDS=123456789,987654321

# Bot 自己的 QQ 号
SELF_NUMBER=10001

# 可选
NODE_ENV=development
REPLY_MEDIA_WAIT_N=5
REPLY_MEDIA_TIMEOUT_MS=5000
MEMORY_JOB_INTERVAL_HOURS=4
MEMORY_JOB_SKIP_THRESHOLD=20
JOB_INTER_DELAY_MS=200
```

### 必填项说明

- `DATABASE_URL`: PostgreSQL 连接串
- `REDIS_URL`: Redis 连接串
- `NAPCAT_WS_URL`: NapCat WebSocket 地址
- `NAPCAT_ACCESS_TOKEN`: NapCat 鉴权 token
- `GROUP_IDS`: 要监听的 QQ 群号列表
- `SELF_NUMBER`: 机器人自己的 QQ 号

### Gemini 说明

Gemini 不是必需项。项目启动时会自动检查以下文件是否存在：

- `~/.gemini/oauth_creds.json`
- 或项目内 `.gemini/oauth_creds.json`

如果存在，就启用 LLM 相关功能；如果不存在，机器人仍可启动，但图片描述、摘要、自动回复等能力会被关闭。

## 数据库初始化

首次启动前先准备数据库表结构。

推荐方式：

```bash
pnpm db:migrate
```

如果只是本地快速同步 schema，也可以：

```bash
pnpm db:push
```

如需重新生成 Prisma Client：

```bash
pnpm db:generate
```

## 启动方式

### 开发模式

```bash
pnpm dev
```

开发模式会使用 `tsx watch` 监听源码变更并自动重启。

### 生产构建

先构建：

```bash
pnpm build
```

再启动：

```bash
pnpm start
```

## 使用说明

### 1. 启动依赖服务

确保以下服务都已经可用：

- PostgreSQL
- Redis
- NapCat WebSocket

### 2. 配置群号和机器人账号

在 `.env` 中填写：

- `GROUP_IDS`: 需要监听的群
- `SELF_NUMBER`: 当前机器人 QQ 号

机器人只会处理 `GROUP_IDS` 中的群消息。

### 3. 启动机器人

运行：

```bash
pnpm dev
```

启动成功后，程序会：

- 连接数据库
- 连接 NapCat
- 启动任务队列
- 启动记忆刷新定时任务
- 对已配置群执行最近历史消息补拉

### 4. 在群里使用

项目当前更偏向“消息接入 + 存储 + 回复管线”。

你可以这样验证是否正常工作：

- 在配置的 QQ 群里发送文本消息
- 发送图片等媒体消息
- 查看终端日志是否输出消息处理记录
- 查看 PostgreSQL 中 `messages`、`media`、`group_memory`、`user_memory` 表是否有新增数据

如果本地已配置 Gemini 凭据，还可以进一步验证：

- 图片是否生成描述
- 机器人是否基于上下文进行回复
- 定时任务是否更新群记忆/用户记忆

## 常用命令

```bash
pnpm dev          # 开发模式启动
pnpm build        # 构建 TypeScript
pnpm start        # 启动构建产物
pnpm db:generate  # 生成 Prisma Client
pnpm db:migrate   # 执行 Prisma 迁移
pnpm db:push      # 直接同步 schema 到数据库
```

## 目录结构

```text
.
├── prisma/               # Prisma schema 和迁移文件
├── src/
│   ├── bot/              # NapCat 接入、消息处理
│   ├── config/           # 环境变量和配置
│   ├── database/         # Prisma client 和数据库读写
│   ├── jobs/             # 定时任务
│   ├── llm/              # Gemini 能力适配
│   ├── media/            # 媒体缓存、序列化、描述
│   ├── memory/           # 群记忆/用户记忆逻辑
│   ├── queue/            # 异步队列
│   └── responder/        # 回复生成与执行
└── .env.example          # 环境变量示例
```

## 排查问题

### 启动时报缺少环境变量

检查 `.env` 是否存在，并确认以下字段都已填写：

- `DATABASE_URL`
- `REDIS_URL`
- `NAPCAT_WS_URL`
- `NAPCAT_ACCESS_TOKEN`
- `GROUP_IDS`
- `SELF_NUMBER`

### 能启动但没收到群消息

重点检查：

- NapCat WebSocket 地址和 token 是否正确
- 群号是否包含在 `GROUP_IDS` 中
- NapCat 是否已经登录目标 QQ 账号

### LLM 功能没生效

重点检查：

- `~/.gemini/oauth_creds.json` 是否存在
- 或项目内 `.gemini/oauth_creds.json` 是否存在

如果凭据不存在，项目会正常启动，但会打印 LLM 未启用的日志。

## 最低启动流程

```bash
pnpm install
cp .env.example .env
# 修改 .env
pnpm db:migrate
pnpm dev
```
