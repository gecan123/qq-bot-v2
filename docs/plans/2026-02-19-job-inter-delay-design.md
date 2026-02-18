# Job Inter-Delay Design

Date: 2026-02-19

## Problem

On restart, `backfillGroupMessages` enqueues many `generate-description` jobs in rapid succession. The queue processes them with no pause between tasks, triggering LLM rate limiting.

## Solution

Add a configurable delay between consecutive queue jobs (`JOB_INTER_DELAY_MS`, default 200ms). The queue already processes one job at a time; this change simply adds a pause before picking up the next one.

## Changes

| File | Change |
|------|--------|
| `src/config/index.ts` | Add `jobInterDelayMs` (reads `JOB_INTER_DELAY_MS`, default `200`) |
| `src/queue/memory-queue.ts` | `createMemoryQueue(interJobDelayMs)` parameter; change final `schedule(0)` → `schedule(interJobDelayMs)` |
| `src/queue/index.ts` | Pass `config.jobInterDelayMs` to `createMemoryQueue` |
| `.env.example` | Add `JOB_INTER_DELAY_MS=200` |

## Behaviour

- After each job (success or retry-scheduled), wait `interJobDelayMs` before processing the next
- "No jobs in queue" polling (`POLL_INTERVAL_MS = 1000ms`) is unchanged
- Set `JOB_INTER_DELAY_MS=0` to restore original zero-delay behaviour
