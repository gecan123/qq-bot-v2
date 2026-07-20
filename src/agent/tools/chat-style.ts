import { z } from 'zod'
import { loadPrompt } from '../../config/prompt-loader.js'
import type { GroupPolicy } from '../../config/group-policies.js'
import type { TargetMetadataMaps } from '../resolve-target-meta.js'
import type { Tool } from '../tool.js'

const STYLE_INDEX_PROMPT_PATH = './prompts/chat-style/index.md'

export const GLOBAL_STYLE_SECTIONS = ['constraints', 'base', 'anti_patterns', 'roleplay', 'nsfw'] as const

export type GlobalStyleSection = (typeof GLOBAL_STYLE_SECTIONS)[number]

const STYLE_PROMPT_PATHS = {
  constraints: './prompts/chat-style/constraints.md',
  base: './prompts/chat-style/base.md',
  anti_patterns: './prompts/chat-style/anti-patterns.md',
  roleplay: './prompts/chat-style/roleplay.md',
  nsfw: './prompts/chat-style/nsfw.md',
} as const satisfies Record<GlobalStyleSection, string>

const argsSchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('global').describe('读取 Luna 的全局说话风格指南.'),
    section: z
      .enum(GLOBAL_STYLE_SECTIONS)
      .optional()
      .describe(
        `可选. 不传只返回索引; 传 ${GLOBAL_STYLE_SECTIONS.join(' / ')} 获取具体内容.`,
      ),
  }),
  z.object({
    scope: z.literal('group').describe('读取某个监听群的在场风格定制.'),
    groupId: z.number().int().describe('要查看风格定制的 QQ 群号. 必须来自 system prompt 运行环境里列出的监听群.'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface ChatStyleDeps {
  groupIds: readonly number[]
  metadata: TargetMetadataMaps
  groupPolicies: readonly GroupPolicy[]
}

export function createChatStyleTool(deps: ChatStyleDeps): Tool<Args> {
  const monitoredGroupIds = new Set(deps.groupIds)
  const policyById = new Map(deps.groupPolicies.map((policy) => [policy.id, policy]))

  return {
    name: 'chat_style',
    description: [
      '按需读取聊天风格信息, 一个入口用 scope 决定范围.',
      'scope=global: 读取 Luna 的全局说话风格指南; 不传 section 只返回索引.',
      'scope=group: 读取监听群的 participation 与固定提示.',
      '日常短回复按 system prompt 的核心语气即可, 不要每轮都调用.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      if (args.scope === 'global') {
        if (!args.section) {
          return { content: loadPrompt(STYLE_INDEX_PROMPT_PATH) }
        }
        return { content: loadPrompt(STYLE_PROMPT_PATHS[args.section]) }
      }

      if (!monitoredGroupIds.has(args.groupId)) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `groupId=${args.groupId} is not monitored`,
          }),
        }
      }

      const policy = policyById.get(args.groupId)
      return {
        content: JSON.stringify({
          ok: true,
          groupId: args.groupId,
          groupName: deps.metadata.groupNames.get(args.groupId) ?? null,
          participation: policy?.participation ?? 'mentions',
          guidance: policy?.guidance ?? '',
        }),
      }
    },
  }
}
