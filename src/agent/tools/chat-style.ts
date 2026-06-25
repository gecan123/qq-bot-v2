import { z } from 'zod'
import { loadPromptSection } from '../../config/prompt-loader.js'
import type { GroupCustomization } from '../../config/group-prompts.js'
import type { TargetMetadataMaps } from '../resolve-target-meta.js'
import type { Tool } from '../tool.js'

const STYLE_PROMPT_PATH = './prompts/bot-style.md'
const CHAT_CONSTRAINTS_PROMPT_PATH = './prompts/bot-chat-constraints.md'

const sectionNames = {
  constraints: { path: CHAT_CONSTRAINTS_PROMPT_PATH, section: 'chat_constraints' },
  base: { path: STYLE_PROMPT_PATH, section: 'style_base' },
  anti_patterns: { path: STYLE_PROMPT_PATH, section: 'style_anti_patterns' },
  special_cases: { path: STYLE_PROMPT_PATH, section: 'style_special_cases' },
} as const

const argsSchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('global').describe('读取 Luna 的全局说话风格指南.'),
    section: z
      .enum(['constraints', 'base', 'anti_patterns', 'special_cases'])
      .optional()
      .describe('可选. 不传只返回索引; 传 constraints / base / anti_patterns / special_cases 获取具体内容.'),
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
  groupCustomizations: readonly GroupCustomization[]
}

export function createChatStyleTool(deps: ChatStyleDeps): Tool<Args> {
  const monitoredGroupIds = new Set(deps.groupIds)
  const customById = new Map(deps.groupCustomizations.map((custom) => [custom.id, custom]))

  return {
    name: 'chat_style',
    description: [
      '按需读取聊天风格信息, 一个入口用 scope 决定范围.',
      'scope=global: 读取 Luna 的全局说话风格指南; 不传 section 只返回索引.',
      'scope=group: 读取某个监听群的在场风格、活跃度和 groups.yaml 群口味正文.',
      '日常短回复按 system prompt 的核心语气即可, 不要每轮都调用.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      if (args.scope === 'global') {
        if (!args.section) {
          return { content: loadPromptSection(STYLE_PROMPT_PATH, 'style_index') }
        }
        const target = sectionNames[args.section]
        return { content: loadPromptSection(target.path, target.section) }
      }

      if (!monitoredGroupIds.has(args.groupId)) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `groupId=${args.groupId} is not monitored`,
          }),
        }
      }

      const custom = customById.get(args.groupId)
      return {
        content: JSON.stringify({
          ok: true,
          groupId: args.groupId,
          groupName: deps.metadata.groupNames.get(args.groupId) ?? null,
          frequencyHint: custom?.frequencyHint ?? 'normal',
          body: custom?.body ?? '',
        }),
      }
    },
  }
}
