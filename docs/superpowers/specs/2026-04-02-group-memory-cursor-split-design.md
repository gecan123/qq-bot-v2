# Group Memory Cursor Split Design

## Context

`group_memory` currently stores both the business artifact (`summary`) and the incremental processing cursor (`last_message_id`, `last_message_db_id`). The two cursor fields represent different namespaces and make the model hard to reason about.

## Goals

- Separate business data from processing state.
- Make incremental refresh semantics explicit.
- Treat cursor state as rebuildable cache.
- If cursor state is missing, rebuild from only the most recent 24 hours of messages.

## Design

### Business model

`group_memory` keeps only durable business state:

- `group_id`
- `group_name`
- `summary`
- `updated_at`

### Cursor model

Add a new `group_memory_cursor` table for incremental refresh state:

- `group_id`
- `last_processed_message_row_id`
- `last_processed_external_message_id`
- `updated_at`

`last_processed_message_row_id` is the primary incremental cursor. `last_processed_external_message_id` is auxiliary metadata for inspection and debugging.

### Refresh behavior

- If cursor exists, refresh scans `messages.id > last_processed_message_row_id`.
- If cursor is missing, refresh scans only messages from the latest 24 hours.
- Prefer `sent_at` for the 24-hour window and fall back to `created_at` when `sent_at` is null.
- After a successful refresh, update both `group_memory` and `group_memory_cursor`.

## Migration approach

- Create `group_memory_cursor`.
- Backfill one cursor row per existing `group_memory` row using the current `last_message_id` and `last_message_db_id`.
- Remove cursor columns from `group_memory`.

## Risks

- Existing code paths that read `GroupMemory` may assume cursor columns still exist.
- The 24-hour fallback may produce a shorter summary after cache loss by design.
