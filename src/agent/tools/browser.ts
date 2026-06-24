import type { Tool } from '../tool.js'
import type { ToolResultContentBlock } from '../agent-context.types.js'
import { config } from '../../config/index.js'
import { BrowserControllerClient } from '../../browser/client.js'
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
  return {
    name: 'browser',
    description: [
      '真实浏览器单步操作工具. 只有一个入口, action 决定动作.',
      '底层是 sidecar 管理的 headed CloakBrowser persistent profile, 登录态和 cookie 可跨进程复用.',
      '一次只做一步: help/status/open/switch_page/close_page/observe/click/type/press/scroll/screenshot/download/annotate/request_owner_help.',
      '先用 observe 拿 elementId; 需要视觉判断时用 screenshot, 截图会作为 image block 进入历史.',
      '普通浏览、发帖、评论、点赞、Cloudflare/Turnstile/cookie 弹窗可自主处理; 登录/2FA/账号安全/OAuth/支付/可执行下载等请求主人.',
      '详细参数先调用 action=help.',
    ].join(' '),
    schema: browserActionInputSchema,
    async execute(args) {
      const result = await deps.client.action(args)
      return { content: resultToToolContent(result) }
    },
  }
}

function resultToToolContent(result: BrowserActionJsonResult): string | ToolResultContentBlock[] {
  if (!result.image) return browserJsonResultToText(result)
  return [
    { type: 'text', text: browserJsonResultToText(result) },
    result.image,
  ]
}
