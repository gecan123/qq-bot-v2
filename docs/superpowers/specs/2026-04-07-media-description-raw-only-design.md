# Media Description Raw-Only Design

Date: 2026-04-07
Scope: bot/backend media description pipeline
Status: Approved for planning

## Goal

Make `media.descriptionRaw` the only source of truth for media descriptions.

The system should stop storing or reading flattened string fields such as `media.description`, image `summary`, or other media-specific text projections. Instead, every media segment should carry the full structured description object so downstream code can consume the JSON directly.

This change is a direct migration. Historical compatibility is out of scope.

## Current State

The current backend writes media descriptions twice:

- `media.description` stores a flattened string
- `media.descriptionRaw` stores structured JSON

Read paths still depend on the flattened field:

- `generate-description` skips work when `media.description` already exists
- `message-resolver` fetches `description` and projects it back into segments
- image segments receive `summary`
- video, audio, and file segments receive `description`
- `media-reanalyze` clears and returns both fields

This creates two problems:

1. The source of truth is ambiguous because both flattened and structured forms exist.
2. Runtime behavior is inconsistent because different media types expose different description fields.

## Non-Goals

This design does not include:

- compatibility logic for old rows or old segment shapes
- backfilling old data
- automatic projection from structured JSON back into display strings
- admin-web changes

## Product Direction

The backend should expose one consistent contract for all media types:

- media description state is represented only by `descriptionRaw`
- message resolution returns the full structured description object
- downstream consumers decide which fields inside that object they want to use

The resolver should stop deciding that images need `summary` while other media need `description`. That interpretation belongs in the consumer, not in the shared backend resolution layer.

## Data Model

### Database

`Media.description` should be removed from the Prisma schema and database column set.

`Media.descriptionRaw` remains and becomes the only persisted description field.

The migration can be destructive because old data has already been cleared. The schema should be updated directly instead of carrying a temporary compatibility state.

### Structured Description Contract

The stored value in `descriptionRaw` should be a JSON object.

The exact object shape may vary by media type, but the runtime contract should require that it is an object rather than a scalar or free-form string. Different media analyzers may provide fields such as:

- `description`
- `summary`
- `ocrText`
- `transcript`
- `frames`
- other media-specific structured fields

The resolver does not reinterpret or normalize those fields into one flattened string.

## Runtime Design

### Description Generation

`generate-description` should:

- stop selecting or checking `media.description`
- consider a media item already described only when `descriptionRaw` exists
- write only `descriptionRaw`
- reject invalid results when the provider returns `null`, a scalar, or an empty object

The current string-normalization path should be removed. The generation pipeline should validate that the provider returned a usable structured object and persist that object directly.

### Message Resolution

`resolveMessage` should:

- query `descriptionRaw`
- attach the full object to every media segment through one unified field

Recommended segment field:

- `mediaDescription`

This field should be used for image, video, record, and file segments equally.

The resolver should no longer emit:

- image `summary`
- video `description`
- record `description`
- file `description`

It should only attach the structured object when `descriptionRaw` is a valid object. Invalid or missing values should be ignored rather than repaired heuristically.

### Reanalyze Flow

`media-reanalyze` should:

- clear only `descriptionRaw`
- regenerate only `descriptionRaw`
- return only `descriptionRaw` in the response payload

There is no need to keep a parallel flattened description in the API.

### Pending/Completed State

Any code that decides whether a media item still needs analysis should use only `descriptionRaw` state.

That includes:

- queue scheduling checks
- resolver wait logic
- explicit reanalyze endpoints
- related tests

## Type Changes

The message segment types should be updated so media segments share one structured field:

- `mediaDescription`

Old text-only description fields should be removed from the media segment contracts where they only existed as resolved media projections.

The important boundary is:

- resolver output is structured JSON
- text extraction, display formatting, and summarization happen downstream and explicitly

This makes the interface stable as new description fields are added later.

## Affected Areas

The following backend areas are expected to change together:

1. `prisma/schema.prisma`
2. migration for dropping `description` and keeping `description_raw`
3. `src/jobs/generate-description.ts`
4. `src/media/message-resolver.ts`
5. `src/server/media-reanalyze.ts`
6. `src/types/message-segments.ts`
7. any backend utility or responder code that still expects resolved string description fields
8. related tests

Unused compatibility code should be deleted rather than preserved.

## Error Handling

The pipeline should fail closed on malformed structured output.

Rules:

1. If the provider result is missing, `null`, a scalar, or an empty object, the job should treat it as not generated and leave the row unresolved.
2. If `descriptionRaw` in storage is not a valid object, the resolver should skip attaching `mediaDescription`.
3. No fallback string projection should be introduced in resolver code.

These rules keep the contract strict and make malformed data visible instead of silently inventing a string.

## Verification

The minimum verification scope for implementation is:

1. update `generate-description` tests to verify only `descriptionRaw` is written
2. update `message-resolver` tests to verify all media types receive structured `mediaDescription`
3. update pending-state tests so readiness is based only on `descriptionRaw`
4. update reanalyze tests to clear and return only `descriptionRaw`
5. run `pnpm build`

## Open Questions

No open product questions remain for planning.

The implementation plan should focus on removing the old flattened path cleanly and updating all compile-time callers to the new structured contract.
