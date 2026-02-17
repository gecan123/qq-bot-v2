# Media Content-Hash Dedup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure identical media content is stored exactly once globally by hashing file bytes and reusing existing `mediaId`.

**Architecture:** Add a nullable `data_hash` column with a unique index in `media`, compute SHA-256 for downloaded media bytes, and switch write flow to find-or-create by hash. Keep existing fallback behavior for failures and skip historical backfill in this scope.

**Tech Stack:** TypeScript (Node.js ESM), Prisma + PostgreSQL, tsx, pnpm.

---

### Task 1: Add Schema Support For Hash Dedup

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_media_data_hash/migration.sql` (generated)

**Step 1: Write the failing schema expectation**

```prisma
model Media {
  // ...
  dataHash String? @map("data_hash") @db.VarChar(64)
  @@unique([dataHash])
}
```

Expected failure now: `dataHash` does not exist in generated client types.

**Step 2: Add schema fields**

Update `Media` in `prisma/schema.prisma`:
- Add `dataHash String? @map("data_hash") @db.VarChar(64)`
- Add `@@unique([dataHash])`

**Step 3: Generate migration and client**

Run: `pnpm db:migrate --name add_media_data_hash`  
Expected: migration created and applied locally.

Run: `pnpm db:generate`  
Expected: Prisma client regenerated with `dataHash` in `Media`.

**Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/generated/prisma
git commit -m "feat: add media data hash schema for dedup"
```

### Task 2: Add Deterministic Hash Utility With Tests

**Files:**
- Create: `src/media/media-hash.ts`
- Create: `src/media/media-hash.test.ts`
- Modify: `package.json` (if needed for test command)

**Step 1: Write failing tests**

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeMediaHash } from './media-hash.js'

describe('computeMediaHash', () => {
  it('returns same hash for same content', () => {
    const a = Buffer.from('abc')
    const b = Buffer.from('abc')
    assert.equal(computeMediaHash(a), computeMediaHash(b))
  })

  it('returns different hash for different content', () => {
    const a = Buffer.from('abc')
    const b = Buffer.from('abd')
    assert.notEqual(computeMediaHash(a), computeMediaHash(b))
  })
})
```

**Step 2: Run tests to verify failure**

Run: `pnpm tsx --test src/media/media-hash.test.ts`  
Expected: FAIL because `computeMediaHash` is missing.

**Step 3: Write minimal implementation**

```ts
import { createHash } from 'node:crypto'

export function computeMediaHash(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
```

**Step 4: Run tests to verify pass**

Run: `pnpm tsx --test src/media/media-hash.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/media/media-hash.ts src/media/media-hash.test.ts package.json
git commit -m "test: add media hash utility tests"
```

### Task 3: Implement Find-Or-Create Media By Hash

**Files:**
- Modify: `src/media/media-cache.ts`
- Modify: `src/generated/prisma` (if regenerated due type changes)

**Step 1: Write failing behavior test scaffold (or reproducible check)**

Create a temporary reproducible scenario in a dev group:
1. Send identical media twice.
2. Query DB expecting one `media` row by hash.

Expected now: two rows are created.

**Step 2: Refactor media save flow**

In `src/media/media-cache.ts`:
- Import `computeMediaHash`.
- After download, compute `dataHash` from bytes.
- Query existing media by `dataHash`.
- If found: return existing `mediaId` immediately.
- If not found: create media row with `dataHash`.
- Enqueue description job only on create path.

**Step 3: Add race-condition handling**

Wrap create path:
- Catch Prisma unique-constraint error for `data_hash`.
- Re-query by `dataHash` and return existing `mediaId`.
- Re-throw only if retry lookup also fails.

**Step 4: Keep non-goal behavior explicit**

Maintain current branch for `fileSize > 20MB`:
- Continue metadata-only insert.
- Do not set `dataHash`.
- Do not dedup this branch in current scope.

**Step 5: Build and verify**

Run: `pnpm build`  
Expected: PASS.

**Step 6: Manual verification**

Run SQL check after sending same media multiple times:

```sql
SELECT data_hash, COUNT(*)
FROM media
WHERE data_hash IS NOT NULL
GROUP BY data_hash
HAVING COUNT(*) > 1;
```

Expected: no rows for repeated test media.

**Step 7: Commit**

```bash
git add src/media/media-cache.ts src/generated/prisma
git commit -m "feat: deduplicate media by content hash"
```

### Task 4: Final Verification And Rollout Notes

**Files:**
- Modify: `docs/plans/2026-02-17-media-dedup-design.md` (optional short status note)
- Modify: `README.md` (only if operational note needed)

**Step 1: End-to-end verification**

Run:
- `pnpm build`
- Live message test with repeated media in target QQ group

Expected:
- Messages all persist.
- Repeated media reuses one `mediaId`.
- Description generation only occurs for first insert.

**Step 2: Add rollout note (optional)**

Document:
- Migration requirement before deploy.
- No historical backfill included.

**Step 3: Commit**

```bash
git add docs README.md
git commit -m "chore: document media hash dedup rollout notes"
```
