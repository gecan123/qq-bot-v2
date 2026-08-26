import type { Tool } from '../tool.js'
import type { ToolResultContentBlock } from '../agent-context.types.js'
import { config } from '../../config/index.js'
import { BrowserControllerClient } from '../../browser/client.js'
import { createToolResultProgressTracker } from '../tool-progress.js'
import {
  type BrowserActionInput,
  type BrowserActionJsonResult,
  browserActionInputSchema,
  browserJsonResultToText,
} from '../../browser/protocol.js'

export interface BrowserToolDeps {
  client?: Pick<BrowserControllerClient, 'action'>
}

export function maybeCreateBrowserTool(deps: BrowserToolDeps = {}): Tool<BrowserActionInput> | null {
  if (!config.browser.enabled && !deps.client) return null

  const client = deps.client ?? new BrowserControllerClient({
    baseUrl: config.browser.controllerUrl,
    timeoutMs: config.browser.actionTimeoutMs + 2_000,
  })

  return createBrowserTool({ client })
}

export function createBrowserTool(deps: Required<BrowserToolDeps>): Tool<BrowserActionInput> {
  const progress = createToolResultProgressTracker()
  return {
    name: 'browser',
    description: [
      '真实浏览器单步操作工具. 只有一个入口, action 决定动作.',
      '底层是 sidecar 管理的 headed CloakBrowser persistent profile, 登录态和 cookie 可跨进程复用.',
      '一次只做一步: help/status/open/switch_page/close_page/observe/read/click/type/press/scroll/screenshot/download/annotate/request_owner_help.',
      'open 默认复用当前页面; 需要并行阅读才传 newPage=true.',
      '阅读优先用 read; 长页面按 nextTextOffset 分页. 交互前用 observe 拿 elementId; 需要视觉判断时用 screenshot.',
      'controller 默认 read-only: 允许打开、阅读、滚动、导航按键、普通链接和截图；禁止输入、下载、annotation、坐标点击和按钮操作.',
      '登录/2FA/账号安全/OAuth/支付等请求主人; 不要索取、记录或复述 credential/cookie/token.',
      '详细参数先调用 action=help.',
    ].join(' '),
    schema: browserActionInputSchema,
    async execute(args) {
      const result = await deps.client.action(args)
      const summary = stableBrowserResult(result)
      const changed = result.ok && progress.observe(browserProgressKey(args, result), summary)
      return {
        content: resultToToolContent(result),
        outcome: {
          ok: result.ok,
          code: result.ok ? (changed ? 'observed' : 'unchanged') : result.code,
          ...(result.error ? { error: result.error } : {}),
          progress: changed,
        },
      }
    },
  }
}

function browserProgressKey(input: BrowserActionInput, result: BrowserActionJsonResult): string {
  return JSON.stringify([
    result.action,
    result.pageId ?? input.pageId ?? '',
    input.url ?? '',
    input.scope ?? '',
    input.offset ?? '',
    input.direction ?? '',
    input.amount ?? '',
    input.fullPage ?? false,
  ])
}

function stableBrowserResult(result: BrowserActionJsonResult): string {
  const stable = {
    ...result,
    pages: result.pages?.map(({ lastUsedAt: _lastUsedAt, ...page }) => page),
    image: undefined,
    artifactId: undefined,
    artifactPath: undefined,
  }
  return JSON.stringify(stable)
}

function resultToToolContent(result: BrowserActionJsonResult): string | ToolResultContentBlock[] {
  if (!result.image) return browserJsonResultToText(result)
  return [
    { type: 'text', text: browserJsonResultToText(result) },
    result.image,
  ]
}
