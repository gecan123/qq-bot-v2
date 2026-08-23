import type { AgentContext } from './agent-context.js'
import { AgentLedgerHeadChangedError, type AgentLedgerRepo } from './agent-ledger-repo.js'
import type { AgentRuntimeState, CompactionAgentLedgerEntry, CompactionReason } from './agent-ledger.types.js'
import {
  createCompactionCandidate,
  prepareCompaction,
  summarizeCachedClaudeCompaction,
  summarizeCompactionCandidate,
  type MaybeCompactOptions,
} from './compaction.js'
import { runAfterCompactHook } from './compaction-hooks.js'
import { estimateLedgerContextTokens } from './compaction-token-estimator.js'
import { projectAgentLedger } from './agent-ledger-projection.js'
import { parseMailboxContinuityState, recordMailboxCompaction } from './mailbox-continuity.js'
import type { LlmClient } from './llm-client.js'
import type { ToolExecutor } from './tool.js'
import { buildWorkingContextProjection } from './working-context.js'
import { createLogger } from '../logger.js'

const log = createLogger('COMPACTION_COORDINATOR')

export interface CompactionCoordinator {
  compact(input: {
    reason: CompactionReason
    contextTokens: number
    contextWindowTokens: number
    providerPrefixHeadEntryId?: bigint | null
  }): Promise<boolean>
  start(): void
  stop(): void
}

export function createCompactionCoordinator(deps: {
  context: AgentContext
  repo: AgentLedgerRepo
  llm: LlmClient
  tools: ToolExecutor
  systemPrompt: string
  options?: MaybeCompactOptions
  defaultReserveTokens: number
  defaultKeepRecentTokens: number
  defaultFailureBackoffMs: number
  installRuntimeState(state: AgentRuntimeState): void
  reloadProjectionFromCanonical(): Promise<void>
}): CompactionCoordinator {
  let nextAttemptAt = 0
  let abortController = new AbortController()

  return {
    start() {
      if (abortController.signal.aborted) abortController = new AbortController()
    },
    stop() {
      abortController.abort(new Error('bot loop stopping'))
    },
    async compact(input) {
      const options = deps.options ?? {}
      const nowMs = options.nowMs ?? Date.now
      if (input.reason === 'threshold' && nowMs() < nextAttemptAt) {
        log.debug({ retryAfterMs: nextAttemptAt - nowMs() }, 'compaction_failure_backoff_skipped')
        return false
      }
      const recordThresholdFailure = (reason: string): void => {
        if (input.reason !== 'threshold') return
        nextAttemptAt = nowMs() + Math.max(1, options.failureBackoffMs ?? deps.defaultFailureBackoffMs)
        log.warn({ reason, nextAttemptAt }, 'canonical_compaction_backoff_recorded')
      }
      const reserveTokens = options.reserveTokens
        ?? (options.triggerTokens == null
          ? deps.defaultReserveTokens
          : Math.max(0, input.contextWindowTokens - options.triggerTokens))
      const keepRecentTokens = options.keepRecentTokens ?? deps.defaultKeepRecentTokens
      if (
        input.reason === 'threshold'
        && input.providerPrefixHeadEntryId == null
        && input.contextTokens <= Math.max(0, input.contextWindowTokens - reserveTokens)
      ) return false

      for (let headAttempt = 0; headAttempt < 2; headAttempt++) {
        const canonical = await deps.repo.loadCanonicalState()
        const effectiveContextTokens = input.reason === 'threshold'
          && input.providerPrefixHeadEntryId != null
          ? estimateLedgerContextTokens({
              entries: canonical.entries,
              providerPrefix: {
                throughEntryId: input.providerPrefixHeadEntryId,
                inputTokens: input.contextTokens,
              },
            }).tokens
          : input.contextTokens
        if (
          input.reason === 'threshold'
          && effectiveContextTokens <= Math.max(0, input.contextWindowTokens - reserveTokens)
        ) return false

        const latestProjection = projectAgentLedger(canonical)
        const previousCompaction = [...canonical.entries]
          .reverse()
          .find((entry): entry is CompactionAgentLedgerEntry => entry.entryType === 'compaction') ?? null
        const preparation = prepareCompaction({
          entries: canonical.entries,
          latestProjection,
          previousCompaction,
          contextTokens: effectiveContextTokens,
          contextWindowTokens: input.contextWindowTokens,
          reserveTokens,
          keepRecentTokens,
          reason: input.reason,
        })
        if (preparation == null) return false
        if (preparation.status !== 'ready') {
          recordThresholdFailure(preparation.reason)
          return false
        }

        const compactedContinuity = parseMailboxContinuityState(canonical.runtimeState.mailboxContinuity)
        recordMailboxCompaction(compactedContinuity)
        let candidate: Awaited<ReturnType<typeof createCompactionCandidate>>
        try {
          let summarize = options.summarizeCandidate
          if (summarize == null && deps.llm.provider === 'claude-code' && !preparation.isSplitTurn) {
            const activeMessageCount = preparation.entriesToSummarize.length + preparation.tailEntries.length
            const syntheticMessageCount = latestProjection.snapshot.messages.length - activeMessageCount
            const prefixMessageCount = syntheticMessageCount + preparation.entriesToSummarize.length
            if (syntheticMessageCount < 0 || prefixMessageCount <= 0 || prefixMessageCount >= latestProjection.snapshot.messages.length) {
              throw new Error('cached Claude compaction prefix does not match canonical projection')
            }
            const workingProjection = await buildWorkingContextProjection(latestProjection.snapshot.messages)
            const cachedPrefix = workingProjection.messages.slice(0, prefixMessageCount)
            const visibleTools = deps.tools.list()
            summarize = (_request, { signal }) => summarizeCachedClaudeCompaction({
              llm: deps.llm,
              systemPrompt: deps.systemPrompt,
              messages: cachedPrefix,
              tools: visibleTools,
              ...(options.maxSummaryTokens == null ? {} : { maxSummaryTokens: options.maxSummaryTokens }),
              signal,
            })
          }
          summarize ??= (request, { signal }) => summarizeCompactionCandidate(request, { signal, llm: deps.llm })
          candidate = await createCompactionCandidate({
            entries: canonical.entries,
            runtimeState: { ...canonical.runtimeState, mailboxContinuity: compactedContinuity },
            preparation,
            summarize,
            hooks: options.hooks,
            signal: abortController.signal,
            maxSummaryTokens: options.maxSummaryTokens,
          })
        } catch (error) {
          recordThresholdFailure('summarizer_failed')
          log.error({ error, reason: input.reason }, 'canonical_compaction_candidate_failed')
          return false
        }
        if (candidate.status !== 'ready') {
          if (candidate.status !== 'cancelled' || candidate.reason !== 'aborted') recordThresholdFailure(candidate.reason)
          return false
        }

        try {
          const committed = await deps.repo.appendCompaction({
            expectedHeadEntryId: preparation.expectedHeadEntryId,
            payload: candidate.payload,
            runtimePatch: { mailboxContinuity: compactedContinuity },
          })
          const committedEntry = committed.appendedEntries.find(
            (entry): entry is CompactionAgentLedgerEntry => entry.entryType === 'compaction',
          )
          if (!committedEntry) throw new Error('compaction commit returned no compaction entry')
          deps.context.installProjection(candidate.projection.snapshot)
          deps.installRuntimeState(committed.runtimeState)
          try {
            await deps.reloadProjectionFromCanonical()
          } catch (error) {
            log.warn({ error }, 'post_compaction_reload_failed_committed_projection_retained')
          }
          nextAttemptAt = 0
          await runAfterCompactHook(options.hooks ?? {}, {
            committedEntry,
            metrics: {
              tokensBefore: candidate.payload.tokensBefore,
              estimatedTokensAfter: candidate.payload.estimatedTokensAfter,
              compressedEntryCount: preparation.entriesToSummarize.length,
              keptEntryCount: preparation.tailEntries.length,
            },
          }, (error) => log.warn({ error }, 'after_compact_hook_failed'))
          log.info({
            reason: input.reason,
            committedEntryId: committedEntry.id,
            tokensBefore: candidate.payload.tokensBefore,
            estimatedTokensAfter: candidate.payload.estimatedTokensAfter,
          }, 'canonical_compaction_committed')
          return true
        } catch (error) {
          if (error instanceof AgentLedgerHeadChangedError && headAttempt === 0) {
            log.info({
              expectedHeadEntryId: error.expectedHeadEntryId,
              actualHeadEntryId: error.actualHeadEntryId,
            }, 'canonical_compaction_head_changed_recalculating')
            continue
          }
          recordThresholdFailure(error instanceof AgentLedgerHeadChangedError ? 'head_changed' : 'commit_failed')
          log.error({ error, reason: input.reason }, 'canonical_compaction_commit_failed')
          return false
        }
      }
      return false
    },
  }
}
