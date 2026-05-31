import type { BrowserActionInput, BrowserActionJsonResult } from './protocol.js'

export interface BrowserControllerClientOptions {
  baseUrl: string
  timeoutMs: number
  fetcher?: typeof fetch
}

export class BrowserControllerClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch

  constructor(options: BrowserControllerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs
    this.fetcher = options.fetcher ?? fetch
  }

  async action(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(`${this.baseUrl}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: controller.signal,
      })
      const text = await response.text()
      let parsed: unknown
      try {
        parsed = text ? JSON.parse(text) : {}
      } catch {
        return {
          ok: false,
          action: input.action,
          code: 'browser_controller_bad_json',
          error: `Browser controller returned non-JSON response (${response.status})`,
        }
      }
      if (!response.ok) {
        return {
          ok: false,
          action: input.action,
          code: 'browser_controller_http_error',
          error: `Browser controller HTTP ${response.status}: ${text.slice(0, 500)}`,
        }
      }
      return parsed as BrowserActionJsonResult
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return {
        ok: false,
        action: input.action,
        code: aborted ? 'browser_controller_timeout' : 'browser_controller_unavailable',
        error: aborted ? `Browser controller timed out after ${this.timeoutMs}ms` : String(err),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
