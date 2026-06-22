/**
 * cloak headers/常量。整段一次拼装, 启动后不变 (AGENTS.md / CLAUDE.md 红线 5: system prompt 字节稳定)。
 *
 * 这些常量从 kagami `apps/server/src/llm/providers/claude-code-provider.ts` 原样移植 ——
 * 它们让请求看起来像真实 Claude Code CLI 流量, 让 Anthropic OAuth quota 走订阅免费额度。
 * 修改任何一项 (UA/beta/billing) = 风控可能识别 = 订阅 quota 失效。集中改, 不小步频改。
 */

export const ANTHROPIC_VERSION = '2023-06-01'
export const ANTHROPIC_BETA = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24',
].join(',')
export const CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.76 (external, sdk-cli)'
export const CLAUDE_CODE_SDK_PROMPT =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."
export const CLAUDE_CODE_BILLING_HEADER =
  'x-anthropic-billing-header: cc_version=2.1.76.b57; cc_entrypoint=sdk-cli; cch=00000;'

export interface ClaudeCodeHeaderInput {
  accessToken: string
  /** 用于 X-Stainless-Timeout (秒)。 */
  timeoutMs: number
}

export function buildClaudeCodeHeaders(input: ClaudeCodeHeaderInput): Record<string, string> {
  return {
    Authorization: `Bearer ${input.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Anthropic-Version': ANTHROPIC_VERSION,
    'Anthropic-Beta': ANTHROPIC_BETA,
    'Anthropic-Dangerous-Direct-Browser-Access': 'true',
    'User-Agent': CLAUDE_CODE_USER_AGENT,
    'X-App': 'cli',
    'X-Stainless-Retry-Count': '0',
    'X-Stainless-Runtime-Version': process.version,
    'X-Stainless-Package-Version': '0.74.0',
    'X-Stainless-Runtime': 'node',
    'X-Stainless-Lang': 'js',
    'X-Stainless-Arch': toClaudeCodeRuntimeArch(),
    'X-Stainless-OS': toClaudeCodeRuntimeOs(),
    'X-Stainless-Timeout': String(Math.max(1, Math.trunc(input.timeoutMs / 1000))),
    Connection: 'keep-alive',
  }
}

function toClaudeCodeRuntimeArch(): string {
  return process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
}

function toClaudeCodeRuntimeOs(): string {
  switch (process.platform) {
    case 'darwin':
      return 'MacOS'
    case 'linux':
      return 'Linux'
    case 'win32':
      return 'Windows'
    default:
      return process.platform
  }
}
