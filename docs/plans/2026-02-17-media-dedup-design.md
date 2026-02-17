# Media Content-Hash Dedup Design

## Background

`media` table currently stores duplicate rows when the same file is repeatedly sent in group chats (common for stickers/memes). The current write path always creates a new `media` row after download, so repeated files are repeatedly parsed, stored, and scheduled for description generation.

## Scope

- Deduplicate media globally across all groups.
- Use content hash as the uniqueness key.
- Keep existing message linkage model (`messages.media_reference_ids` references `mediaId`).
- Exclude historical backfill in this iteration.

## Goals

- Store one `media` row per unique file content.
- Reuse existing `mediaId` for repeated media.
- Avoid duplicate description jobs for reused media.

## Non-Goals

- Backfilling old `media` rows that already exist.
- Deduplicating metadata-only large files (>20MB) that are not downloaded.
- Perceptual/near-duplicate matching.

## Approach Options

1. `dataHash` unique index (recommended)
- Add `data_hash` column to `media`.
- Compute SHA-256 from downloaded bytes.
- Reuse existing row by hash; only create when hash is new.

2. Composite metadata key (`fileName`, `fileSize`, `mediaType`)
- Rejected due to high false positive/negative risk.

3. Perceptual hash (pHash)
- Rejected for current scope due to complexity and non-uniform applicability.

## Data Model Changes

`Media` model:
- Add `dataHash String? @map("data_hash") @db.VarChar(64)`
- Add unique constraint on `dataHash`

Notes:
- Column is nullable for migration safety.
- New downloaded records must set `dataHash`.
- Existing rows without hash remain valid and unchanged.

## Write Path Design

For downloadable media:
1. Resolve URL and download bytes.
2. Compute `sha256(bytes)` as `dataHash`.
3. Lookup existing media by `dataHash`.
4. If found, return existing `mediaId`.
5. If not found, create new row with bytes and `dataHash`.
6. Enqueue description job only when a new row is created.

For files larger than 20MB:
- Keep current metadata-only behavior.
- Do not compute content hash.
- No dedup in this branch for large metadata-only entries.

## Concurrency and Error Handling

- Add unique index guard on `dataHash`.
- On concurrent insert race causing unique-constraint error:
1. Catch error.
2. Re-query by `dataHash`.
3. Reuse the existing `mediaId`.

Failure behavior remains unchanged:
- Media cache failure does not block message persistence.
- Original segment is preserved when media write fails.

## Validation

Manual verification:
1. Send the same media file 5 times in a monitored group.
2. Confirm `messages` inserts continue for all 5 messages.
3. Confirm `media` row count increases by only 1 for this content hash.
4. Confirm all repeated messages reference the same `mediaId`.
5. Confirm description job enqueued only once for the new hash.
