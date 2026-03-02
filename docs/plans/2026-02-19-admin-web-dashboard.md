# Admin Web Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a read-only admin dashboard in `apps/admin-web` to browse QQ bot data (messages, groups, AI memory, media) stored in PostgreSQL.

**Architecture:** Next.js 16 App Router with async Server Components for all data pages (direct Prisma queries server-side). One API Route (`/api/media/[mediaId]`) serves binary media blobs. No auth. No search in this iteration — simple pagination only.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, shadcn/ui (New York/slate), Prisma 7 with `@prisma/adapter-pg`, PostgreSQL.

---

## Context & Key Constraints

- All work is inside `apps/admin-web/` unless noted
- BigInt fields (`groupId`, `messageId`, `senderId`) must be converted to `string` before passing to React components (JSON can't serialize BigInt)
- Images stored in DB as `Bytes` — served via API route, not directly in pages
- `ParsedSegment` union type is defined in `../../src/types/message-segments.ts` — copy it rather than importing cross-app

---

### Task 1: Add Prisma to admin-web

**Files:**
- Create: `apps/admin-web/prisma/schema.prisma`
- Create: `apps/admin-web/lib/prisma.ts`
- Modify: `apps/admin-web/package.json`

**Step 1: Copy the Prisma schema**

Copy `prisma/schema.prisma` (repo root) to `apps/admin-web/prisma/schema.prisma`, then update the `output` path:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../lib/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

// ... rest of schema identical to repo root prisma/schema.prisma
```

Full schema to write (copy from repo root `prisma/schema.prisma` — all 4 models: Message, Media, GroupMemory, UserMemory).

**Step 2: Add dependencies**

In `apps/admin-web/`, run:
```bash
pnpm add @prisma/client @prisma/adapter-pg pg
pnpm add -D prisma @types/pg
```

**Step 3: Generate Prisma client**

```bash
cd apps/admin-web && pnpm exec prisma generate
```

Expected: `lib/generated/prisma/` directory created with client files.

**Step 4: Create `lib/prisma.ts`**

```typescript
import { PrismaClient } from './generated/prisma/client.js'
import { PrismaPg } from '@prisma/adapter-pg'

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
})

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```

(The `globalForPrisma` singleton pattern prevents multiple client instances during Next.js hot reload in dev.)

**Step 5: Verify TypeScript compiles**

```bash
cd apps/admin-web && pnpm exec tsc --noEmit
```

Expected: no errors.

**Step 6: Commit**

```bash
git add apps/admin-web/prisma/ apps/admin-web/lib/prisma.ts apps/admin-web/lib/generated/ apps/admin-web/package.json pnpm-lock.yaml
git commit -m "feat(admin-web): add prisma client setup"
```

---

### Task 2: Copy ParsedSegment types

**Files:**
- Create: `apps/admin-web/lib/message-segments.ts`

**Step 1: Copy the type definitions**

Copy the full content of `src/types/message-segments.ts` (repo root) to `apps/admin-web/lib/message-segments.ts`. Content:

```typescript
export interface TextSegment {
  type: 'text'
  content: string
}

export interface ImageSegment {
  type: 'image'
  referenceId?: string
  url?: string
  fileSize?: string
  fileName?: string
  summary?: string
  subType?: number
}

export interface FaceSegment {
  type: 'face'
  faceId: number
  name?: string
}

export interface AtSegment {
  type: 'at'
  targetId: string
  targetName?: string
}

export interface ReplySegment {
  type: 'reply'
  messageId: string
}

export interface VideoSegment {
  type: 'video'
  referenceId?: string
  url?: string
  fileName?: string
  fileSize?: string
  description?: string
}

export interface RecordSegment {
  type: 'record'
  referenceId?: string
  url?: string
  fileName?: string
  fileSize?: string
  description?: string
}

export interface FileSegment {
  type: 'file'
  referenceId?: string
  url?: string
  fileId?: string
  fileName?: string
  fileSize?: string
  description?: string
}

export interface RawSegment {
  type: 'raw'
  originalType: string
  data: unknown
}

export type ParsedSegment =
  | TextSegment
  | ImageSegment
  | VideoSegment
  | RecordSegment
  | FileSegment
  | FaceSegment
  | AtSegment
  | ReplySegment
  | RawSegment
```

**Step 2: Commit**

```bash
git add apps/admin-web/lib/message-segments.ts
git commit -m "feat(admin-web): add ParsedSegment types"
```

---

### Task 3: Query functions (`lib/queries.ts`)

**Files:**
- Create: `apps/admin-web/lib/queries.ts`

**Step 1: Write the query functions**

```typescript
import { prisma } from './prisma'
import type { ParsedSegment } from './message-segments'

// Helper: convert BigInt fields to string in a plain object
function serializeBigInt<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  )
}

// --- Groups ---

export interface GroupSummary {
  groupId: string
  groupName: string | null
  messageCount: number
  lastMessageAt: Date
}

export async function getGroups(): Promise<GroupSummary[]> {
  const rows = await prisma.message.groupBy({
    by: ['groupId', 'groupName'],
    _count: { id: true },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: 'desc' } },
  })
  return rows.map((r) => ({
    groupId: r.groupId.toString(),
    groupName: r.groupName,
    messageCount: r._count.id,
    lastMessageAt: r._max.createdAt!,
  }))
}

// --- Messages ---

export interface MessageRow {
  id: number
  groupId: string
  messageId: string
  senderId: string
  senderNickname: string | null
  senderGroupNickname: string | null
  content: ParsedSegment[]
  createdAt: Date
}

export async function getGroupMessages(
  groupId: string,
  page: number,
  pageSize = 50
): Promise<{ messages: MessageRow[]; total: number }> {
  const groupIdBig = BigInt(groupId)
  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where: { groupId: groupIdBig },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        groupId: true,
        messageId: true,
        senderId: true,
        senderNickname: true,
        senderGroupNickname: true,
        content: true,
        createdAt: true,
      },
    }),
    prisma.message.count({ where: { groupId: groupIdBig } }),
  ])
  return {
    messages: serializeBigInt(messages) as MessageRow[],
    total,
  }
}

// --- Memory ---

export interface GroupMemoryRow {
  groupId: string
  groupName: string | null
  summary: string
  lastMessageId: string
  updatedAt: Date
}

export async function getGroupMemory(groupId: string): Promise<GroupMemoryRow | null> {
  const row = await prisma.groupMemory.findUnique({
    where: { groupId: BigInt(groupId) },
  })
  if (!row) return null
  return serializeBigInt(row) as GroupMemoryRow
}

export interface UserMemoryRow {
  id: number
  groupId: string
  senderId: string
  senderNickname: string | null
  senderGroupNickname: string | null
  profile: string
  updatedAt: Date
}

export async function getUserMemories(groupId: string): Promise<UserMemoryRow[]> {
  const rows = await prisma.userMemory.findMany({
    where: { groupId: BigInt(groupId) },
    orderBy: { updatedAt: 'desc' },
  })
  return serializeBigInt(rows) as UserMemoryRow[]
}

// --- Media ---

export interface MediaMeta {
  mediaId: number
  mediaType: string | null
  contentType: string | null
  fileName: string | null
  fileSize: number | null
  createdAt: Date
}

export async function getMediaList(
  page: number,
  pageSize = 48
): Promise<{ items: MediaMeta[]; total: number }> {
  const [items, total] = await Promise.all([
    prisma.media.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        mediaId: true,
        mediaType: true,
        contentType: true,
        fileName: true,
        fileSize: true,
        createdAt: true,
      },
    }),
    prisma.media.count(),
  ])
  return { items, total }
}
```

**Step 2: Verify TypeScript compiles**

```bash
cd apps/admin-web && pnpm exec tsc --noEmit
```

Expected: no errors.

**Step 3: Commit**

```bash
git add apps/admin-web/lib/queries.ts
git commit -m "feat(admin-web): add DB query functions"
```

---

### Task 4: Media API Route

**Files:**
- Create: `apps/admin-web/app/api/media/[mediaId]/route.ts`

**Step 1: Write the route**

```typescript
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  const { mediaId } = await params
  const media = await prisma.media.findUnique({
    where: { mediaId: Number(mediaId) },
    select: { data: true, contentType: true },
  })
  if (!media) {
    return new Response(null, { status: 404 })
  }
  return new Response(media.data, {
    headers: {
      'Content-Type': media.contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
```

**Step 2: Test manually**

Start dev server: `pnpm --filter admin-web dev`

Visit `http://localhost:3100/api/media/1` in browser. If media exists in DB you'll see the image; if not you'll see a 404. Both are correct.

**Step 3: Commit**

```bash
git add apps/admin-web/app/api/
git commit -m "feat(admin-web): add media binary API route"
```

---

### Task 5: `LazyImage` Client Component

**Files:**
- Create: `apps/admin-web/components/LazyImage.tsx`

**Step 1: Write the component**

```typescript
'use client'

import { useState } from 'react'

interface LazyImageProps {
  mediaId: string | number
  fileName?: string | null
}

export function LazyImage({ mediaId, fileName }: LazyImageProps) {
  const [src, setSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    if (src || loading) return
    setLoading(true)
    try {
      const res = await fetch(`/api/media/${mediaId}`)
      if (!res.ok) throw new Error('Not found')
      const blob = await res.blob()
      setSrc(URL.createObjectURL(blob))
    } catch {
      setSrc('error')
    } finally {
      setLoading(false)
    }
  }

  if (src === 'error') {
    return (
      <span className="text-xs text-muted-foreground">[图片加载失败]</span>
    )
  }

  if (src) {
    return (
      <img
        src={src}
        alt={fileName ?? '图片'}
        className="max-h-48 max-w-xs rounded border object-contain"
      />
    )
  }

  return (
    <button
      onClick={load}
      disabled={loading}
      className="rounded border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50"
    >
      {loading ? '加载中…' : '[图片]'}
    </button>
  )
}
```

**Step 2: Verify TypeScript compiles**

```bash
cd apps/admin-web && pnpm exec tsc --noEmit
```

**Step 3: Commit**

```bash
git add apps/admin-web/components/LazyImage.tsx
git commit -m "feat(admin-web): add LazyImage click-to-load component"
```

---

### Task 6: `SegmentRenderer` Server Component

**Files:**
- Create: `apps/admin-web/components/SegmentRenderer.tsx`

**Step 1: Write the component**

```typescript
import type { ParsedSegment } from '@/lib/message-segments'
import { LazyImage } from './LazyImage'

export function SegmentRenderer({ segment }: { segment: ParsedSegment }) {
  switch (segment.type) {
    case 'text':
      return <span className="whitespace-pre-wrap">{segment.content}</span>

    case 'image':
      if (segment.referenceId) {
        return <LazyImage mediaId={segment.referenceId} fileName={segment.fileName} />
      }
      return <span className="text-xs text-muted-foreground">[图片]</span>

    case 'at':
      return (
        <span className="text-blue-500">
          @{segment.targetName ?? segment.targetId}
        </span>
      )

    case 'face':
      return (
        <span className="text-muted-foreground">
          [{segment.name ?? `表情${segment.faceId}`}]
        </span>
      )

    case 'reply':
      return (
        <span className="text-muted-foreground text-xs">
          [回复:{segment.messageId}]
        </span>
      )

    case 'video':
      return (
        <span className="text-muted-foreground text-xs">
          [视频{segment.fileName ? `: ${segment.fileName}` : ''}]
        </span>
      )

    case 'record':
      return (
        <span className="text-muted-foreground text-xs">
          [语音{segment.fileName ? `: ${segment.fileName}` : ''}]
        </span>
      )

    case 'file':
      return (
        <span className="text-muted-foreground text-xs">
          [文件{segment.fileName ? `: ${segment.fileName}` : ''}]
        </span>
      )

    case 'raw':
      return (
        <span className="text-muted-foreground text-xs">
          [{segment.originalType}]
        </span>
      )

    default:
      return null
  }
}
```

**Step 2: Commit**

```bash
git add apps/admin-web/components/SegmentRenderer.tsx
git commit -m "feat(admin-web): add SegmentRenderer component"
```

---

### Task 7: `MessageRow` Server Component

**Files:**
- Create: `apps/admin-web/components/MessageRow.tsx`

**Step 1: Write the component**

```typescript
import type { MessageRow as MessageRowData } from '@/lib/queries'
import type { ParsedSegment } from '@/lib/message-segments'
import { SegmentRenderer } from './SegmentRenderer'

export function MessageRow({ message }: { message: MessageRowData }) {
  const segments = message.content as ParsedSegment[]
  const displayName = message.senderGroupNickname ?? message.senderNickname ?? message.senderId
  const time = new Date(message.createdAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className="flex gap-3 border-b py-3 last:border-0">
      <div className="w-32 shrink-0 text-right">
        <div className="text-sm font-medium truncate">{displayName}</div>
        <div className="text-xs text-muted-foreground">{time}</div>
      </div>
      <div className="flex-1 flex flex-wrap items-baseline gap-1 text-sm leading-relaxed">
        {segments.map((seg, i) => (
          <SegmentRenderer key={i} segment={seg} />
        ))}
      </div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add apps/admin-web/components/MessageRow.tsx
git commit -m "feat(admin-web): add MessageRow component"
```

---

### Task 8: `Sidebar` Server Component

**Files:**
- Create: `apps/admin-web/components/Sidebar.tsx`

**Step 1: Write the component**

```typescript
import Link from 'next/link'
import { getGroups } from '@/lib/queries'

export async function Sidebar({ activeGroupId }: { activeGroupId?: string }) {
  const groups = await getGroups()

  return (
    <nav className="flex h-full w-56 shrink-0 flex-col gap-1 border-r p-3">
      <div className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground tracking-wider">
        群组
      </div>
      {groups.map((g) => (
        <Link
          key={g.groupId}
          href={`/groups/${g.groupId}`}
          className={`flex flex-col rounded-md px-2 py-1.5 text-sm hover:bg-muted ${
            activeGroupId === g.groupId ? 'bg-muted font-medium' : ''
          }`}
        >
          <span className="truncate">{g.groupName ?? g.groupId}</span>
          <span className="text-xs text-muted-foreground">{g.messageCount} 条消息</span>
        </Link>
      ))}
      <div className="mt-auto border-t pt-2">
        <Link
          href="/media"
          className="flex rounded-md px-2 py-1.5 text-sm hover:bg-muted"
        >
          媒体库
        </Link>
      </div>
    </nav>
  )
}
```

**Step 2: Commit**

```bash
git add apps/admin-web/components/Sidebar.tsx
git commit -m "feat(admin-web): add Sidebar navigation component"
```

---

### Task 9: Update Layout with Sidebar

**Files:**
- Modify: `apps/admin-web/app/layout.tsx`

**Step 1: Update the layout**

Replace the body content to add the two-column layout:

```typescript
import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "QQ Bot Admin",
  description: "Admin WebUI for qq-bot-v2"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="flex h-screen overflow-hidden bg-background text-foreground">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </body>
    </html>
  );
}
```

Note: `Sidebar` is a Server Component that fetches groups. It runs on every request (no caching needed for this admin tool).

**Step 2: Verify dev server starts**

```bash
pnpm --filter admin-web dev
```

Visit `http://localhost:3100` — should see sidebar with groups listed (if DB is connected) or an error to debug.

**Step 3: Commit**

```bash
git add apps/admin-web/app/layout.tsx
git commit -m "feat(admin-web): add two-column layout with sidebar"
```

---

### Task 10: Groups Overview Page

**Files:**
- Modify: `apps/admin-web/app/page.tsx`
- Create: `apps/admin-web/app/groups/page.tsx`

**Step 1: Update home page to redirect**

```typescript
// apps/admin-web/app/page.tsx
import { redirect } from 'next/navigation'

export default function Home() {
  redirect('/groups')
}
```

**Step 2: Create groups overview page**

```typescript
// apps/admin-web/app/groups/page.tsx
import { getGroups } from '@/lib/queries'
import Link from 'next/link'

export default async function GroupsPage() {
  const groups = await getGroups()

  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">群组概览</h1>
      <div className="rounded-xl border">
        {groups.length === 0 && (
          <p className="p-6 text-muted-foreground">暂无数据</p>
        )}
        {groups.map((g, i) => (
          <div
            key={g.groupId}
            className={`flex items-center justify-between p-4 ${i < groups.length - 1 ? 'border-b' : ''}`}
          >
            <div>
              <div className="font-medium">{g.groupName ?? '未知群组'}</div>
              <div className="text-xs text-muted-foreground">ID: {g.groupId}</div>
            </div>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span>{g.messageCount} 条</span>
              <span>{new Date(g.lastMessageAt).toLocaleDateString('zh-CN')}</span>
              <Link
                href={`/groups/${g.groupId}`}
                className="text-primary hover:underline"
              >
                查看
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

**Step 3: Verify in browser**

Visit `http://localhost:3100` — should redirect to `/groups` and show group list.

**Step 4: Commit**

```bash
git add apps/admin-web/app/page.tsx apps/admin-web/app/groups/
git commit -m "feat(admin-web): add groups overview page"
```

---

### Task 11: Message List Page

**Files:**
- Create: `apps/admin-web/app/groups/[groupId]/page.tsx`
- Create: `apps/admin-web/components/Pagination.tsx`

**Step 1: Create `Pagination` component**

```typescript
// apps/admin-web/components/Pagination.tsx
import Link from 'next/link'

interface PaginationProps {
  page: number
  total: number
  pageSize: number
  baseHref: string // e.g. "/groups/123"
}

export function Pagination({ page, total, pageSize, baseHref }: PaginationProps) {
  const totalPages = Math.ceil(total / pageSize)
  if (totalPages <= 1) return null

  return (
    <div className="flex items-center gap-3 text-sm">
      {page > 1 ? (
        <Link
          href={`${baseHref}?page=${page - 1}`}
          className="rounded border px-3 py-1 hover:bg-muted"
        >
          ← 上一页
        </Link>
      ) : (
        <span className="rounded border px-3 py-1 text-muted-foreground opacity-50">← 上一页</span>
      )}
      <span className="text-muted-foreground">
        第 {page} / {totalPages} 页（共 {total} 条）
      </span>
      {page < totalPages ? (
        <Link
          href={`${baseHref}?page=${page + 1}`}
          className="rounded border px-3 py-1 hover:bg-muted"
        >
          下一页 →
        </Link>
      ) : (
        <span className="rounded border px-3 py-1 text-muted-foreground opacity-50">下一页 →</span>
      )}
    </div>
  )
}
```

**Step 2: Create message list page**

```typescript
// apps/admin-web/app/groups/[groupId]/page.tsx
import { getGroupMessages } from '@/lib/queries'
import { MessageRow } from '@/components/MessageRow'
import { Pagination } from '@/components/Pagination'
import Link from 'next/link'

interface Props {
  params: Promise<{ groupId: string }>
  searchParams: Promise<{ page?: string }>
}

export default async function GroupMessagesPage({ params, searchParams }: Props) {
  const { groupId } = await params
  const { page: pageStr } = await searchParams
  const page = Math.max(1, Number(pageStr ?? '1'))
  const PAGE_SIZE = 50

  const { messages, total } = await getGroupMessages(groupId, page, PAGE_SIZE)

  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">消息列表</h1>
        <Link
          href={`/groups/${groupId}/memory`}
          className="text-sm text-muted-foreground hover:text-primary"
        >
          查看 AI 记忆 →
        </Link>
      </div>

      {messages.length === 0 ? (
        <p className="text-muted-foreground">暂无消息</p>
      ) : (
        <>
          <div className="rounded-xl border px-4">
            {messages.map((msg) => (
              <MessageRow key={msg.id} message={msg} />
            ))}
          </div>
          <div className="mt-4">
            <Pagination
              page={page}
              total={total}
              pageSize={PAGE_SIZE}
              baseHref={`/groups/${groupId}`}
            />
          </div>
        </>
      )}
    </div>
  )
}
```

**Step 3: Update Sidebar to accept activeGroupId**

The layout doesn't know the current groupId. Update `layout.tsx` to NOT pass activeGroupId (keep it simple — no active highlighting needed for now, or just style it server-side if possible).

Actually, pass it via a separate layout for `/groups/[groupId]`. Simplest: don't highlight active group for now, remove `activeGroupId` prop from Sidebar. Change `Sidebar` signature to have no props.

**Step 4: Verify in browser**

Visit `http://localhost:3100/groups/[some-group-id]`. Messages should appear with LazyImage placeholders for images.

**Step 5: Commit**

```bash
git add apps/admin-web/components/Pagination.tsx apps/admin-web/app/groups/
git commit -m "feat(admin-web): add message list page with pagination"
```

---

### Task 12: AI Memory Page

**Files:**
- Create: `apps/admin-web/app/groups/[groupId]/memory/page.tsx`

**Step 1: Write the page**

```typescript
import { getGroupMemory, getUserMemories } from '@/lib/queries'

interface Props {
  params: Promise<{ groupId: string }>
}

export default async function MemoryPage({ params }: Props) {
  const { groupId } = await params
  const [groupMemory, userMemories] = await Promise.all([
    getGroupMemory(groupId),
    getUserMemories(groupId),
  ])

  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">AI 记忆</h1>

      {/* Group Memory */}
      <section>
        <h2 className="mb-3 text-lg font-medium">群组总结</h2>
        {groupMemory ? (
          <div className="rounded-xl border p-4 space-y-2">
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{groupMemory.summary}</p>
            <p className="text-xs text-muted-foreground">
              更新于 {new Date(groupMemory.updatedAt).toLocaleString('zh-CN')}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">暂无群组记忆</p>
        )}
      </section>

      {/* User Memories */}
      <section>
        <h2 className="mb-3 text-lg font-medium">成员档案（{userMemories.length} 人）</h2>
        <div className="space-y-3">
          {userMemories.map((u) => (
            <div key={u.id} className="rounded-xl border p-4 space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">
                  {u.senderGroupNickname ?? u.senderNickname ?? u.senderId}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(u.updatedAt).toLocaleDateString('zh-CN')}
                </span>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap line-clamp-3">
                {u.profile}
              </p>
            </div>
          ))}
          {userMemories.length === 0 && (
            <p className="text-muted-foreground text-sm">暂无成员档案</p>
          )}
        </div>
      </section>
    </div>
  )
}
```

**Step 2: Verify in browser**

Visit `http://localhost:3100/groups/[id]/memory`.

**Step 3: Commit**

```bash
git add apps/admin-web/app/groups/
git commit -m "feat(admin-web): add AI memory page"
```

---

### Task 13: Media Gallery Page

**Files:**
- Create: `apps/admin-web/app/media/page.tsx`

**Step 1: Write the page**

```typescript
import { getMediaList } from '@/lib/queries'
import { LazyImage } from '@/components/LazyImage'
import { Pagination } from '@/components/Pagination'

interface Props {
  searchParams: Promise<{ page?: string }>
}

export default async function MediaPage({ searchParams }: Props) {
  const { page: pageStr } = await searchParams
  const page = Math.max(1, Number(pageStr ?? '1'))
  const PAGE_SIZE = 48

  const { items, total } = await getMediaList(page, PAGE_SIZE)

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">媒体库</h1>
        <span className="text-sm text-muted-foreground">共 {total} 项</span>
      </div>

      {items.length === 0 ? (
        <p className="text-muted-foreground">暂无媒体文件</p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-4 sm:grid-cols-6 lg:grid-cols-8">
            {items.map((item) => (
              <div key={item.mediaId} className="flex flex-col items-center gap-1">
                <div className="flex h-20 w-20 items-center justify-center rounded border bg-muted">
                  {item.mediaType === 'image' ? (
                    <LazyImage mediaId={item.mediaId} fileName={item.fileName} />
                  ) : (
                    <span className="text-xs text-muted-foreground text-center px-1">
                      {item.mediaType ?? 'file'}
                    </span>
                  )}
                </div>
                {item.fileSize && (
                  <span className="text-xs text-muted-foreground">
                    {(item.fileSize / 1024).toFixed(0)}KB
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-6">
            <Pagination page={page} total={total} pageSize={PAGE_SIZE} baseHref="/media" />
          </div>
        </>
      )}
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add apps/admin-web/app/media/
git commit -m "feat(admin-web): add media gallery page"
```

---

### Task 14: Final Cleanup

**Files:**
- Modify: `apps/admin-web/CLAUDE.md`
- Add: `apps/admin-web/.env.local` (not committed — just note it)

**Step 1: Update CLAUDE.md constraint**

In `apps/admin-web/CLAUDE.md`, update the Non-Goals section — remove "Do not add database access in pages" (now we use Server Components with Prisma in `lib/`). Replace with: "Do not add database access directly in page components — use query functions from `lib/queries.ts`."

**Step 2: Ensure `.env.local` is set up**

The admin-web needs `DATABASE_URL` to connect to Postgres. Create `apps/admin-web/.env.local` (gitignored):

```
DATABASE_URL=postgresql://...
```

**Step 3: Full build check**

```bash
pnpm --filter admin-web build
```

Expected: build succeeds with no TypeScript errors.

**Step 4: Final commit**

```bash
git add apps/admin-web/CLAUDE.md
git commit -m "chore(admin-web): update CLAUDE.md for DB access pattern"
```

---

## Verification Checklist

- [ ] `pnpm --filter admin-web dev` starts on port 3100 without errors
- [ ] `/` redirects to `/groups`
- [ ] `/groups` lists all monitored groups with message counts
- [ ] `/groups/[groupId]` shows 50 messages/page, newest first
- [ ] Clicking `[图片]` in a message loads the image from DB
- [ ] Next/Prev pagination works on message list
- [ ] `/groups/[groupId]/memory` shows group summary + user profiles
- [ ] `/media` shows media grid with lazy-load images
- [ ] `pnpm --filter admin-web build` succeeds (no TypeScript errors)
