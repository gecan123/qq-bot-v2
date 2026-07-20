# WebAdmin Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 建立基于 TanStack Start 的只读 WebAdmin 第一条完整纵向切片：workspace、应用壳、server-only Postgres 查询、类型安全 Overview DTO、轮询总览页和验证门禁。

**Architecture:** `apps/admin-web` 是独立 TanStack Start Node 应用。浏览器只调用同源 Server Function；Server Function 通过 server-only Prisma client 调用可注入的只读 query service，返回经 Zod 校验、BigInt/Date 已序列化且不包含秘密的 DTO。第一条纵向切片只展示 ledger/runtime/Goal/token/tool-call 汇总，不执行任何写操作。

**Tech Stack:** TanStack Start 1.168.32、React 19.2.7、TanStack Router 1.170.18、TanStack Query 5.101.2、Vite 8.1.5、Tailwind CSS 4.3.3、Zod 4.4.3、Vitest 4.1.10、Testing Library 16.3.2、Prisma 7.4.0。

---

## 范围说明

本计划只实现设计文档中的“基础设施 + 总览纵向切片”。Context/Ledger 详情、时间序列指标、QQ 消息/媒体和 Runtime 详情分别另写后续计划。这样可以先验证 TanStack Start RC、server/client 边界、workspace 集成和数据库只读路径，再扩大页面范围。

执行前阅读：

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/AGENT_CONTEXT.md`
- `docs/OPERATIONS.md`
- `docs/plans/2026-07-20-webadmin-frontend-stack-design.md`

仓库要求默认直接在 `main` 开发；不要为本计划另建 feature branch 或部署服务。`apps/admin-web/.env.local`、`.next/`、`node_modules/` 和其他已忽略旧产物属于本地状态，不读取、不提交，也不做清理。

### Task 1: 恢复 workspace 与 Admin Web 局部约束

**Files:**

- Create: `pnpm-workspace.yaml`
- Create: `apps/admin-web/AGENTS.md`
- Create: `apps/admin-web/CLAUDE.md`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `scripts/repo-check.ts`
- Test: `src/ops/repo-check.test.ts`
- Modify: `src/ops/repo-check.ts`

**Step 1: 写失败的 repo-check 测试**

在 `src/ops/repo-check.test.ts` 增加测试，构造存在 `apps/admin-web/AGENTS.md`、但缺少或内容不同的 `CLAUDE.md` 的虚拟文件集，断言返回错误包含：

```text
apps/admin-web/AGENTS.md and CLAUDE.md must be byte-identical
```

再增加二者完全相同时通过的测试。

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm test -- src/ops/repo-check.test.ts
```

Expected: FAIL，因为 `repo-check` 尚未检查局部指令镜像。

**Step 3: 实现最小 repo-check 规则**

在 `src/ops/repo-check.ts` 的现有文件读取抽象上增加可选的 Admin Web 文件字段和条件规则：只有 `apps/admin-web/AGENTS.md` 或 `apps/admin-web/CLAUDE.md` 至少一个存在时才校验；两者必须都存在且字节一致。同步修改 `scripts/repo-check.ts`，只读取这两个显式路径，不递归扫描 `.next`、`node_modules` 或其他 ignored 产物。

从 `README_REMOVED_SURFACES` 移除字符串 `admin-web`，但保留所有旧 per-scene 表和目录 marker；相应测试改为只拒绝旧模型，不再把新 `apps/admin-web` 名称本身视为错误。

**Step 4: 创建 workspace 文件**

`pnpm-workspace.yaml`：

```yaml
packages:
  - apps/*
```

**Step 5: 创建字节一致的局部指令**

`apps/admin-web/AGENTS.md` 与 `apps/admin-web/CLAUDE.md` 内容完全一致：

```markdown
# Admin Web Agent 指令

本目录是只读 WebAdmin，技术栈为 TanStack Start、React、TanStack Router/Query、Tailwind CSS 4 和 Zod。

- 修改前先读仓库根 `AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/AGENT_CONTEXT.md` 和对应设计/实施计划。
- 浏览器代码不得导入 Prisma、Node API、环境变量、bot runtime 或 server-only 模块。
- 数据库和文件访问只允许出现在显式 `*.server.ts` 模块；server-only 模块首行导入 `@tanstack/react-start/server-only`。
- 第一阶段所有管理接口只读。禁止直接更新 ledger、runtime state、checkpoint、Goal、消息、媒体或 workspace side-data。
- 所有跨 server/client 数据必须经过 Zod DTO；BigInt 转十进制字符串，Date 转 ISO 8601。
- 默认绑定 `127.0.0.1`。没有另行设计鉴权前，不得暴露到非可信网络。
- 新行为测试先行；至少运行本 app 的 test、typecheck、build，再运行根 `pnpm repo-check`。
```

执行：

```bash
cmp -s apps/admin-web/AGENTS.md apps/admin-web/CLAUDE.md
```

Expected: exit 0。

**Step 6: 更新根脚本和 ignore**

在根 `package.json` 增加：

```json
"web:dev": "pnpm --filter @qq-bot/admin-web dev",
"web:test": "pnpm --filter @qq-bot/admin-web test",
"web:typecheck": "pnpm --filter @qq-bot/admin-web typecheck",
"web:build": "pnpm --filter @qq-bot/admin-web build"
```

在 `.gitignore` 增加：

```gitignore
apps/admin-web/.output/
apps/admin-web/.tanstack/
apps/admin-web/coverage/
```

保留现有 `.next/` ignore，以免旧本地产物进入版本库。

**Step 7: 运行测试和检查**

Run:

```bash
pnpm test -- src/ops/repo-check.test.ts
pnpm repo-check
```

Expected: 两者 PASS。

**Step 8: 提交**

```bash
git add pnpm-workspace.yaml apps/admin-web/AGENTS.md apps/admin-web/CLAUDE.md .gitignore package.json scripts/repo-check.ts src/ops/repo-check.ts src/ops/repo-check.test.ts
git commit -m "chore: 恢复 WebAdmin workspace 边界"
```

### Task 2: 建立锁版本的 TanStack Start 应用壳

**Files:**

- Create: `apps/admin-web/package.json`
- Create: `apps/admin-web/tsconfig.json`
- Create: `apps/admin-web/vite.config.ts`
- Create: `apps/admin-web/vitest.config.ts`
- Create: `apps/admin-web/src/vite-env.d.ts`
- Create: `apps/admin-web/src/router.tsx`
- Create: `apps/admin-web/src/routes/__root.tsx`
- Create: `apps/admin-web/src/routes/index.tsx`
- Create: `apps/admin-web/src/styles.css`
- Generated: `apps/admin-web/src/routeTree.gen.ts`
- Modify: `pnpm-lock.yaml`

**Step 1: 写 package manifest**

`apps/admin-web/package.json` 使用精确版本，不写 `^`、`~` 或 `latest`：

```json
{
  "name": "@qq-bot/admin-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev --host 127.0.0.1 --port 20030",
    "generate-routes": "tsr generate",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "vite build",
    "preview": "vite preview --host 127.0.0.1 --port 20030"
  },
  "dependencies": {
    "@prisma/adapter-pg": "7.4.0",
    "@tanstack/react-query": "5.101.2",
    "@tanstack/react-router": "1.170.18",
    "@tanstack/react-start": "1.168.32",
    "@tailwindcss/vite": "4.3.3",
    "lucide-react": "1.25.0",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "tailwindcss": "4.3.3",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@tanstack/router-cli": "1.167.21",
    "@testing-library/dom": "10.4.1",
    "@testing-library/react": "16.3.2",
    "@types/node": "25.2.3",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "6.0.3",
    "jsdom": "29.1.1",
    "typescript": "5.9.3",
    "vite": "8.1.5",
    "vitest": "4.1.10"
  }
}
```

如果安装时 peer dependency 明确拒绝 TypeScript 5.9.3，再单独评估 TypeScript 6/7；不要在同一提交静默升级根项目 TypeScript。

**Step 2: 创建 TypeScript、Vite 和 Vitest 配置**

`apps/admin-web/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["vite/client", "node"]
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

`apps/admin-web/vite.config.ts`：

```ts
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tailwindcss(), tanstackStart(), react()],
  server: { host: '127.0.0.1', port: 20030 },
  preview: { host: '127.0.0.1', port: 20030 },
})
```

`apps/admin-web/vitest.config.ts`：

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
```

`apps/admin-web/src/vite-env.d.ts`：

```ts
/// <reference types="vite/client" />
```

**Step 3: 写最小 Router/Query 壳**

`apps/admin-web/src/router.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { routeTree } from './routeTree.gen'

export interface AdminRouterContext {
  queryClient: QueryClient
}

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: 5_000,
      },
      mutations: { retry: false },
    },
  })

  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
    Wrap: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
```

`apps/admin-web/src/routes/__root.tsx`：

```tsx
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { AdminRouterContext } from '../router'
import appCss from '../styles.css?url'

export const Route = createRootRouteWithContext<AdminRouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'QQ Bot WebAdmin' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: Outlet,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head><HeadContent /></head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
```

`apps/admin-web/src/routes/index.tsx`：

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  return <main className="p-6"><h1 className="text-2xl font-semibold">QQ Bot WebAdmin</h1></main>
}
```

`apps/admin-web/src/styles.css`：

```css
@import "tailwindcss";

:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  color: #191817;
  background: #f4f1ea;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; }
button, input, select { font: inherit; }
```

**Step 4: 安装并生成 route tree**

Run:

```bash
pnpm install
pnpm web:build
```

Expected: lockfile 更新，`src/routeTree.gen.ts` 生成，build PASS。若 CLI 生成文件头声明自动生成，仍提交该文件，保证 typecheck 在干净 checkout 可运行。

**Step 5: 运行基础验证**

```bash
pnpm web:typecheck
pnpm web:test
```

Expected: typecheck PASS；Vitest 报告无测试但 exit 0。如果当前 Vitest 对无测试返回非零，在 script 使用 `vitest run --passWithNoTests`，并在 Task 3 添加首个测试后移除该 flag。

**Step 6: 提交**

```bash
git add apps/admin-web/package.json apps/admin-web/tsconfig.json apps/admin-web/vite.config.ts apps/admin-web/vitest.config.ts apps/admin-web/src pnpm-lock.yaml
git commit -m "feat: 初始化 TanStack Start 管理台"
```

### Task 3: 定义只读 Overview DTO 与查询服务

**Files:**

- Create: `apps/admin-web/src/features/overview/overview.schema.ts`
- Create: `apps/admin-web/src/features/overview/overview.service.ts`
- Test: `apps/admin-web/src/features/overview/overview.service.test.ts`

**Step 1: 定义 DTO schema**

`overview.schema.ts` 导出严格 Zod schema 和推导类型：

```ts
import { z } from 'zod'

const focusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('group'), id: z.string().regex(/^\d+$/) }).strict(),
  z.object({ type: z.literal('private'), id: z.string().regex(/^\d+$/) }).strict(),
])

export const overviewSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime({ offset: true }),
  readOnly: z.literal(true),
  ledger: z.object({
    entryCount: z.number().int().nonnegative(),
    headEntryId: z.string().regex(/^\d+$/).nullable(),
    latestEntryType: z.string().nullable(),
    latestEntryAt: z.iso.datetime({ offset: true }).nullable(),
  }).strict(),
  runtime: z.object({
    available: z.boolean(),
    updatedAt: z.iso.datetime({ offset: true }).nullable(),
    lastWakeAt: z.iso.datetime({ offset: true }).nullable(),
    focus: focusSchema.nullable(),
  }).strict(),
  goal: z.object({
    goalId: z.string().uuid(),
    objective: z.string(),
    status: z.string(),
    tokensUsed: z.number().int().nonnegative(),
    tokenBudget: z.number().int().positive().nullable(),
    revision: z.number().int().positive(),
    updatedAt: z.iso.datetime({ offset: true }),
  }).strict().nullable(),
  latestAgentUsage: z.object({
    ts: z.iso.datetime({ offset: true }),
    model: z.string(),
    inputTokens: z.number().int().nonnegative().nullable(),
    cachedTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cacheHitRate: z.number().min(0).max(1).nullable(),
  }).strict().nullable(),
  tools24h: z.object({
    calls: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }).strict(),
  warnings: z.array(z.string()),
}).strict()

export type OverviewSnapshot = z.infer<typeof overviewSnapshotSchema>
```

**Step 2: 写失败的 service 测试**

测试使用内存 fake，不连接数据库。固定 `now = 2026-07-20T08:00:00.000Z`，返回：

- ledger count 12、head `42n`、latest type `compaction`
- runtime focus `{ type: 'group', groupId: 123 }`
- active Goal 和最新 `agent.chat` usage
- tool call 24h 总数 9、失败数 2

断言：

```ts
assert.equal(result.ledger.headEntryId, '42')
assert.deepEqual(result.runtime.focus, { type: 'group', id: '123' })
assert.equal(result.latestAgentUsage?.cacheHitRate, 0.75)
assert.deepEqual(result.tools24h, { calls: 9, failed: 2 })
assert.equal(result.generatedAt, '2026-07-20T08:00:00.000Z')
```

再写 invalid focus 测试：输入 `{ type: 'group', groupId: 'bad' }`，期望 `focus: null` 且 `warnings` 包含 `runtime.qqConversationFocus invalid`。

**Step 3: 运行测试确认失败**

```bash
pnpm web:test -- overview.service.test.ts
```

Expected: FAIL，因为 service 尚不存在。

**Step 4: 实现可注入的只读查询 service**

`overview.service.ts` 定义最小 `OverviewDb` port，只暴露以下 Prisma 风格方法：

```ts
export interface OverviewDb {
  botAgentLedgerEntry: {
    count(): Promise<number>
    findFirst(input: object): Promise<{ id: bigint; entryType: string; createdAt: Date } | null>
  }
  botAgentRuntimeState: {
    findUnique(input: object): Promise<{
      qqConversationFocus: unknown
      lastWakeAt: Date | null
      updatedAt: Date
    } | null>
  }
  botAgentGoal: {
    findUnique(input: object): Promise<{
      goalId: string
      objective: string
      status: string
      tokensUsed: number
      tokenBudget: number | null
      revision: number
      updatedAt: Date
    } | null>
  }
  agentTokenUsage: {
    findFirst(input: object): Promise<{
      ts: Date
      model: string
      inputTokens: number | null
      cachedTokens: number | null
      outputTokens: number | null
      cacheHitRate: number | null
    } | null>
  }
  agentToolCall: { count(input: object): Promise<number> }
}
```

实现：

```ts
export async function loadOverviewSnapshot(
  db: OverviewDb,
  now: Date = new Date(),
): Promise<OverviewSnapshot> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const [entryCount, head, runtime, goal, usage, calls, failed] = await Promise.all([
    db.botAgentLedgerEntry.count(),
    db.botAgentLedgerEntry.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true, entryType: true, createdAt: true },
    }),
    db.botAgentRuntimeState.findUnique({
      where: { id: 1 },
      select: { qqConversationFocus: true, lastWakeAt: true, updatedAt: true },
    }),
    db.botAgentGoal.findUnique({
      where: { id: 1 },
      select: {
        goalId: true, objective: true, status: true, tokensUsed: true,
        tokenBudget: true, revision: true, updatedAt: true,
      },
    }),
    db.agentTokenUsage.findFirst({
      where: { operation: 'agent.chat' },
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      select: {
        ts: true, model: true, inputTokens: true, cachedTokens: true,
        outputTokens: true, cacheHitRate: true,
      },
    }),
    db.agentToolCall.count({ where: { ts: { gte: since } } }),
    db.agentToolCall.count({ where: { ts: { gte: since }, ok: false } }),
  ])

  const warnings: string[] = []
  const focus = parseFocus(runtime?.qqConversationFocus, warnings)
  return overviewSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    readOnly: true,
    ledger: {
      entryCount,
      headEntryId: head?.id.toString() ?? null,
      latestEntryType: head?.entryType ?? null,
      latestEntryAt: head?.createdAt.toISOString() ?? null,
    },
    runtime: {
      available: runtime !== null,
      updatedAt: runtime?.updatedAt.toISOString() ?? null,
      lastWakeAt: runtime?.lastWakeAt?.toISOString() ?? null,
      focus,
    },
    goal: goal === null ? null : { ...goal, updatedAt: goal.updatedAt.toISOString() },
    latestAgentUsage: usage === null ? null : {
      ...usage,
      ts: usage.ts.toISOString(),
      cacheHitRate: usage.cacheHitRate ?? deriveCacheHitRate(usage),
    },
    tools24h: { calls, failed },
    warnings,
  })
}
```

`parseFocus` 只接受 `{type:'group', groupId: positive safe integer}` 或 `{type:'private', userId: positive safe integer}`，输出统一 `{type,id:string}`；`null` 保持 `null`，其他值添加 warning。`deriveCacheHitRate` 仅在 `inputTokens > 0` 且 cached 非空时计算，并 clamp 到 `[0,1]`。

**Step 5: 运行测试**

```bash
pnpm web:test -- overview.service.test.ts
pnpm web:typecheck
```

Expected: PASS。

**Step 6: 提交**

```bash
git add apps/admin-web/src/features/overview
git commit -m "feat: 增加管理台只读总览模型"
```

### Task 4: 建立 server-only Prisma 和 Server Function 边界

**Files:**

- Create: `apps/admin-web/src/server/env.server.ts`
- Create: `apps/admin-web/src/server/db.server.ts`
- Create: `apps/admin-web/src/features/overview/overview.server.ts`
- Create: `apps/admin-web/.env.example`
- Test: `apps/admin-web/src/server/env.server.test.ts`

**Step 1: 写失败的环境解析测试**

测试 `parseAdminServerEnv`：

- 合法 `DATABASE_URL=postgresql://user:pass@localhost:5432/db` 返回该值。
- 缺失或非 PostgreSQL URL 时抛出不包含原始密码的错误。

**Step 2: 运行测试确认失败**

```bash
pnpm web:test -- env.server.test.ts
```

Expected: FAIL。

**Step 3: 实现 server-only env**

`env.server.ts`：

```ts
import '@tanstack/react-start/server-only'
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.url().refine(
    value => value.startsWith('postgresql://') || value.startsWith('postgres://'),
    'DATABASE_URL must be a PostgreSQL URL',
  ),
}).strict()

export function parseAdminServerEnv(env: NodeJS.ProcessEnv) {
  const result = schema.safeParse({ DATABASE_URL: env.DATABASE_URL })
  if (!result.success) throw new Error('Admin Web server configuration is invalid')
  return result.data
}
```

**Step 4: 实现 server-only Prisma singleton**

`db.server.ts`：

```ts
import '@tanstack/react-start/server-only'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../../../src/generated/prisma/client.js'
import { parseAdminServerEnv } from './env.server'

const globalForAdminDb = globalThis as typeof globalThis & {
  __qqBotAdminPrisma?: PrismaClient
}

export function getAdminPrisma(): PrismaClient {
  if (globalForAdminDb.__qqBotAdminPrisma) return globalForAdminDb.__qqBotAdminPrisma
  const { DATABASE_URL } = parseAdminServerEnv(process.env)
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) })
  if (process.env.NODE_ENV !== 'production') globalForAdminDb.__qqBotAdminPrisma = prisma
  return prisma
}
```

不要复制 Prisma schema，也不要在 app 内生成第二份 client。schema 仍以根 `prisma/schema.prisma` 为唯一来源。

**Step 5: 实现 Server Function**

`overview.server.ts`：

```ts
import '@tanstack/react-start/server-only'
import { createServerFn } from '@tanstack/react-start'
import { getAdminPrisma } from '../../server/db.server'
import { loadOverviewSnapshot } from './overview.service'

export const getOverviewSnapshot = createServerFn({ method: 'GET' }).handler(
  () => loadOverviewSnapshot(getAdminPrisma()),
)
```

`apps/admin-web/.env.example`：

```dotenv
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/qq_bot
```

**Step 6: 运行静态验证**

```bash
pnpm web:test -- env.server.test.ts
pnpm web:typecheck
pnpm web:build
```

Expected: PASS。`getAdminPrisma()` 是 lazy getter；构建不执行 Server Function handler，因此不要求真实数据库连接或 `DATABASE_URL`。

**Step 7: 检查客户端 bundle 无 server 泄漏**

先用 `find apps/admin-web -maxdepth 4 -type d` 定位构建产物中的浏览器资源目录（通常是 `dist/client` 或 `.output/public`），然后只扫描该 client/public 目录：

```bash
rg -n "DATABASE_URL|postgres(?:ql)?://|PrismaPg|connectionString" <client-output-directory>
```

Expected: 无匹配。Server bundle 合法包含 Prisma，因此禁止用扫描整个 `.output` 的假门禁制造误报。

**Step 8: 提交**

```bash
git add apps/admin-web/src/server apps/admin-web/src/features/overview/overview.server.ts apps/admin-web/.env.example
git commit -m "feat: 建立管理台只读服务端边界"
```

### Task 5: 实现轮询总览页

**Files:**

- Create: `apps/admin-web/src/features/overview/overview.query.ts`
- Create: `apps/admin-web/src/features/overview/OverviewView.tsx`
- Test: `apps/admin-web/src/features/overview/OverviewView.test.tsx`
- Modify: `apps/admin-web/src/routes/index.tsx`
- Modify: `apps/admin-web/src/styles.css`

**Step 1: 写失败的视图测试**

渲染 `OverviewView` 的固定 fixture，断言页面包含：

- `只读模式`
- `Ledger entries` 与 `12`
- `Head #42`
- `群 123`
- Goal objective 和 status
- `75.0%` cache hit rate
- `2 / 9` 工具失败

再渲染 `runtime.available=false`、Goal/usage 为空的 fixture，断言显示明确的 `Runtime 状态缺失` 和 `暂无活跃 Goal`，不抛异常。

**Step 2: 运行测试确认失败**

```bash
pnpm web:test -- OverviewView.test.tsx
```

Expected: FAIL。

**Step 3: 实现 Query options**

`overview.query.ts`：

```ts
import { queryOptions } from '@tanstack/react-query'
import { getOverviewSnapshot } from './overview.server'

export const overviewQueryOptions = queryOptions({
  queryKey: ['overview', 'snapshot'] as const,
  queryFn: () => getOverviewSnapshot(),
  staleTime: 0,
  refetchInterval: 5_000,
  refetchIntervalInBackground: false,
  retry: false,
})
```

**Step 4: 实现纯展示组件**

`OverviewView.tsx` 只接收：

```ts
type OverviewViewProps = {
  snapshot: OverviewSnapshot
  isRefreshing: boolean
  refreshFailed: boolean
}
```

页面结构：

```text
Header: QQ Bot WebAdmin | 只读模式 | 更新于 ... | 刷新中/刷新失败
Cards: Ledger entries | Ledger head | Runtime/focus | Goal
Cards: Latest agent token | Cache hit | Tools 24h | Tool failures
Warnings: 有内容时显示中性告警条
```

不要在此任务引入图表、表格、侧栏、暗色主题或写操作。格式化函数保持组件内私有，除非测试证明需要抽取。

**Step 5: 路由 loader 与轮询 Query 接线**

`routes/index.tsx`：

```tsx
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { OverviewView } from '../features/overview/OverviewView'
import { overviewQueryOptions } from '../features/overview/overview.query'

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(overviewQueryOptions),
  component: OverviewPage,
})

function OverviewPage() {
  const initial = Route.useLoaderData()
  const query = useQuery({ ...overviewQueryOptions, initialData: initial })
  return (
    <OverviewView
      snapshot={query.data}
      isRefreshing={query.isFetching}
      refreshFailed={query.isError}
    />
  )
}
```

保持上一帧成功快照：Query 有旧 `data` 时即使 refetch 失败也继续传旧 snapshot，同时显示 `refreshFailed`。不要在失败时清空页面。

**Step 6: 增加最小响应式样式**

使用 Tailwind utility 完成：移动端单列、`md` 两列、`xl` 四列；卡片使用中性色和清晰边框；状态颜色只表达告警/成功，不复制 Kagami 的完整品牌系统。

**Step 7: 运行验证**

```bash
pnpm web:test -- OverviewView.test.tsx
pnpm web:typecheck
pnpm web:build
```

Expected: PASS。

**Step 8: 提交**

```bash
git add apps/admin-web/src/features/overview apps/admin-web/src/routes/index.tsx apps/admin-web/src/styles.css apps/admin-web/src/routeTree.gen.ts
git commit -m "feat: 增加 WebAdmin 只读总览页"
```

### Task 6: 增加 server/client 边界与只读回归门禁

**Files:**

- Create: `apps/admin-web/src/server/server-boundary.test.ts`
- Modify: `scripts/repo-check.ts`
- Modify: `src/ops/repo-check.ts`
- Test: `src/ops/repo-check.test.ts`

**Step 1: 写失败的边界测试**

测试扫描 `apps/admin-web/src` 中非 `*.server.ts` 文件，拒绝以下 import：

```text
@prisma/*
node:*
../../../../src/generated/prisma/*
src/database/*
process.env
```

允许测试文件本身读取 fixture，但不允许生产浏览器模块触及 server-only 实现。

再在根 repo-check fixture 中加入一个浏览器组件导入 Prisma 的例子，断言 repo-check 报错。

**Step 2: 运行测试确认失败**

```bash
pnpm web:test -- server-boundary.test.ts
pnpm test -- src/ops/repo-check.test.ts
```

Expected: 至少 repo-check 测试 FAIL。

**Step 3: 实现根 repo-check 规则**

`scripts/repo-check.ts` 用 `rg --files apps/admin-web/src` 等价的确定性文件枚举把已跟踪源码传入检查器；规则只扫描 `apps/admin-web/src/**/*.{ts,tsx}`，排除：

- `*.server.ts`
- `*.server.tsx`
- `*.test.ts`
- `*.test.tsx`
- 生成的 `routeTree.gen.ts`

错误必须打印具体文件路径。保持纯词法、确定性，不运行 bundler。

**Step 4: 增加只读 API 形态检查**

在测试中断言第一阶段 `src/features/**/*.server.ts` 不出现 Prisma mutation 方法名：

```text
.create(
.createMany(
.update(
.updateMany(
.upsert(
.delete(
.deleteMany(
.$executeRaw(
```

这是防误用门禁，不替代代码审查。

**Step 5: 运行验证**

```bash
pnpm web:test
pnpm test -- src/ops/repo-check.test.ts
pnpm repo-check
```

Expected: 全部 PASS。

**Step 6: 提交**

```bash
git add apps/admin-web/src/server/server-boundary.test.ts scripts/repo-check.ts src/ops/repo-check.ts src/ops/repo-check.test.ts
git commit -m "test: 收紧 WebAdmin 服务端边界"
```

### Task 7: 更新架构与运维说明并完成验证

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `README.md`

**Step 1: 更新文档**

记录：

- `apps/admin-web` 再次存在，但仅是只读运维面，不改变 bot/backend 主线。
- 技术栈、默认 `127.0.0.1:20030`、所需 `DATABASE_URL`。
- `pnpm web:dev|test|typecheck|build` 命令。
- Start Server Function → read service → Postgres 的数据流。
- WebAdmin 不是 replay source，不能重建或更新 ledger。
- 当前没有管理员鉴权，因此禁止直接绑定非可信接口。
- 当前仅有 Overview；后续页面不要在文档里声称已经存在。

**Step 2: 做完整静态验证**

```bash
cmp -s AGENTS.md CLAUDE.md
cmp -s apps/admin-web/AGENTS.md apps/admin-web/CLAUDE.md
pnpm web:test
pnpm web:typecheck
pnpm web:build
pnpm typecheck
pnpm repo-check
git diff --check
```

Expected: 全部 exit 0。

**Step 3: 做构建产物秘密扫描**

先用 `find apps/admin-web -maxdepth 4 -type d` 定位实际浏览器资源目录，只扫描 `dist/client` 或 `.output/public` 一类 client/public 产物：

```bash
rg -n "DATABASE_URL|postgres(?:ql)?://|PrismaPg|connectionString" <client-output-directory>
```

Expected: 无匹配。不要扫描包含合法 Prisma 代码的 server bundle，也不得省略 client bundle 扫描。

**Step 4: 可选本地烟测**

只有本机已经有可用 Postgres 且用户明确同意读取真实数据时才执行：

```bash
pnpm web:dev
```

记录 PID、端口和 log；用浏览器确认总览加载、5 秒刷新、失败保留旧快照和移动端布局；结束前关闭进程并用 `lsof -iTCP:20030 -sTCP:LISTEN` 确认无遗留监听。没有现成数据库时明确跳过，不为烟测启动 bot、NapCat 或数据库。

**Step 5: 最终提交**

```bash
git add README.md docs/README.md docs/ARCHITECTURE.md docs/OPERATIONS.md
git commit -m "docs: 记录 WebAdmin 只读运行面"
```

**Step 6: 最终状态审计**

```bash
git status --short
git log --oneline -n 8
```

Expected: 只保留任务开始前已有的无关工作区文件；本计划的代码、测试、lockfile 和文档均已提交。不要提交 `docs/plans/2026-07-13-architecture-doc-sync.md`，除非用户另行确认它属于本任务。
