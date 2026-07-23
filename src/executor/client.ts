import type {
  WorkspaceCommandInput,
  WorkspaceCommandResult,
  WorkspaceCommandRunner,
} from './protocol.js'

export interface WorkspaceExecutorClientOptions {
  baseUrl: string
  timeoutMs: number
  token?: string
  fetcher?: typeof fetch
}

export class WorkspaceExecutorClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly token?: string
  private readonly fetcher: typeof fetch

  constructor(options: WorkspaceExecutorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs
    this.token = options.token
    this.fetcher = options.fetcher ?? fetch
  }

  readonly run: WorkspaceCommandRunner = async (input) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers = new Headers({ 'content-type': 'application/json' })
      if (this.token) headers.set('authorization', `Bearer ${this.token}`)
      const response = await this.fetcher(`${this.baseUrl}/run`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        return {
          ok: false,
          code: response.status === 400 ? 'command_not_allowed' : 'executor_error',
          error: `Workspace executor HTTP ${response.status}: ${text.slice(0, 500)}`,
        }
      }
      return JSON.parse(text) as WorkspaceCommandResult
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        code: 'executor_unavailable',
        error: timedOut
          ? `Workspace executor timed out after ${this.timeoutMs}ms`
          : `Workspace executor unavailable: ${String(error)}`,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
