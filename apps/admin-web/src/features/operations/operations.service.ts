import {
  botProcessStatusSchema,
  operationPreviewPayloadSchema,
  operationPreviewSchema,
  operationProgressSchema,
  operationRequestSchema,
  operationResultPayloadSchema,
  operationStartRequestSchema,
  type BotProcessStatusDto,
  type OperationPreview,
  type OperationPreviewPayload,
  type OperationProgress,
  type OperationRequest,
  type OperationResultPayload,
  type OperationStartRequest,
} from './operations.schema.js'

export type OperationProgressReporter = (
  progress: OperationProgress,
) => void | Promise<void>

export interface AdminOperationsPort {
  inspectBot(): Promise<BotProcessStatusDto>
  preview(request: OperationRequest): Promise<OperationPreviewPayload>
  execute(
    request: OperationRequest,
    progress: OperationProgressReporter,
  ): Promise<OperationResultPayload>
}

export interface AdminOperationsServiceOptions {
  now(): Date
  id(): string
  hash(value: string): string
  previewTtlMs: number
}

export class AdminOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'AdminOperationError'
  }
}

export function createAdminOperationsService(
  port: AdminOperationsPort,
  options: AdminOperationsServiceOptions,
): {
    createPreview(request: OperationRequest): Promise<OperationPreview>
    getPreview(previewId: string): OperationPreview | null
    execute(
      input: OperationStartRequest,
      progress: OperationProgressReporter,
    ): Promise<OperationResultPayload>
  } {
  if (!Number.isFinite(options.previewTtlMs) || options.previewTtlMs <= 0) {
    throw new Error('previewTtlMs must be positive')
  }
  const previews = new Map<string, OperationPreview>()

  return {
    async createPreview(requestInput) {
      const request = operationRequestSchema.parse(requestInput)
      const [bot, payload] = await Promise.all([
        port.inspectBot().then(value => botProcessStatusSchema.parse(value)),
        port.preview(request).then(value => operationPreviewPayloadSchema.parse(value)),
      ])
      assertPayloadMatchesRequest(request, payload)
      const createdAt = options.now()
      const preview = operationPreviewSchema.parse({
        schemaVersion: 1,
        id: options.id(),
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + options.previewTtlMs).toISOString(),
        fingerprint: fingerprint(request, payload, options.hash),
        request,
        bot,
        confirmationPhrase: confirmationPhrase(request),
        payload,
      })
      previews.set(preview.id, preview)
      return preview
    },

    getPreview(previewId) {
      return previews.get(previewId) ?? null
    },

    async execute(inputValue, progress) {
      const input = operationStartRequestSchema.parse(inputValue)
      const preview = previews.get(input.previewId)
      if (!preview) throw new AdminOperationError('preview_not_found', 'preview is missing or belongs to an earlier server process')
      if (input.confirmation !== preview.confirmationPhrase) {
        throw new AdminOperationError('confirmation_mismatch', 'confirmation phrase does not match')
      }
      if (options.now().getTime() >= Date.parse(preview.expiresAt)) {
        throw new AdminOperationError('preview_expired', 'preview has expired')
      }

      const bot = botProcessStatusSchema.parse(await port.inspectBot())
      if (!bot.stopped) {
        throw new AdminOperationError('bot_running', `Bot process ${bot.pid} must be stopped manually`)
      }

      const currentPayload = operationPreviewPayloadSchema.parse(await port.preview(preview.request))
      assertPayloadMatchesRequest(preview.request, currentPayload)
      const currentFingerprint = fingerprint(preview.request, currentPayload, options.hash)
      if (currentFingerprint !== preview.fingerprint) {
        throw new AdminOperationError('preview_stale', 'operation inputs changed; create a new preview')
      }
      if (!currentPayload.needed) {
        throw new AdminOperationError('operation_not_needed', 'preview reports no changes to apply')
      }

      const checkedProgress: OperationProgressReporter = value => progress(operationProgressSchema.parse(value))
      return operationResultPayloadSchema.parse(await port.execute(preview.request, checkedProgress))
    },
  }
}

function confirmationPhrase(request: OperationRequest): string {
  switch (request.operation) {
    case 'reset_state': return `RESET ${request.scope}`
    case 'migrate_memory_v2': return 'MIGRATE MEMORY V2'
    case 'canonicalize_memory': return 'CANONICALIZE MEMORY'
    case 'migrate_state_language': return 'MIGRATE STATE LANGUAGE'
  }
}

function fingerprint(
  request: OperationRequest,
  payload: OperationPreviewPayload,
  hash: (value: string) => string,
): string {
  return hash(canonicalJson({ request, payload }))
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

function assertPayloadMatchesRequest(
  request: OperationRequest,
  payload: OperationPreviewPayload,
): void {
  if (request.operation !== payload.operation) {
    throw new AdminOperationError('operation_mismatch', 'preview payload operation does not match request')
  }
  if (
    request.operation === 'reset_state'
    && payload.operation === 'reset_state'
    && request.scope !== payload.scope
  ) {
    throw new AdminOperationError('operation_mismatch', 'reset preview scope does not match request')
  }
}
