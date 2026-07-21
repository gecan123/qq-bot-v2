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
  preview(request: OperationRequest): Promise<{
    payload: OperationPreviewPayload
    stateFingerprint: string
  }>
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
    preflight(input: OperationStartRequest): Promise<OperationPreview>
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
      cleanupPreviews(previews, options.now())
      const [bot, material] = await Promise.all([
        port.inspectBot().then(value => botProcessStatusSchema.parse(value)),
        port.preview(request),
      ])
      const payload = operationPreviewPayloadSchema.parse(material.payload)
      const stateFingerprint = parseStateFingerprint(material.stateFingerprint)
      assertPayloadMatchesRequest(request, payload)
      const createdAt = options.now()
      const preview = operationPreviewSchema.parse({
        schemaVersion: 1,
        id: options.id(),
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + options.previewTtlMs).toISOString(),
        fingerprint: fingerprint(request, payload, stateFingerprint, options.hash),
        request,
        bot,
        confirmationPhrase: confirmationPhrase(request),
        payload,
      })
      previews.set(preview.id, preview)
      while (previews.size > 100) previews.delete(previews.keys().next().value as string)
      return preview
    },

    getPreview(previewId) {
      cleanupPreviews(previews, options.now(), previewId)
      return previews.get(previewId) ?? null
    },

    async preflight(inputValue) {
      const input = operationStartRequestSchema.parse(inputValue)
      cleanupPreviews(previews, options.now(), input.previewId)
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

      const currentMaterial = await port.preview(preview.request)
      const currentPayload = operationPreviewPayloadSchema.parse(currentMaterial.payload)
      const currentStateFingerprint = parseStateFingerprint(currentMaterial.stateFingerprint)
      assertPayloadMatchesRequest(preview.request, currentPayload)
      const currentFingerprint = fingerprint(
        preview.request,
        currentPayload,
        currentStateFingerprint,
        options.hash,
      )
      if (currentFingerprint !== preview.fingerprint) {
        throw new AdminOperationError('preview_stale', 'operation inputs changed; create a new preview')
      }
      if (!currentPayload.needed) {
        throw new AdminOperationError('operation_not_needed', 'preview reports no changes to apply')
      }

      return preview
    },

    async execute(inputValue, progress) {
      const preview = await this.preflight(inputValue)
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
  stateFingerprint: string,
  hash: (value: string) => string,
): string {
  return hash(canonicalJson({ request, payload, stateFingerprint }))
}

function parseStateFingerprint(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('stateFingerprint must be a SHA-256 digest')
  return value
}

function cleanupPreviews(
  previews: Map<string, OperationPreview>,
  now: Date,
  keepId?: string,
): void {
  for (const [id, preview] of previews) {
    if (id !== keepId && now.getTime() >= Date.parse(preview.expiresAt)) previews.delete(id)
  }
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
