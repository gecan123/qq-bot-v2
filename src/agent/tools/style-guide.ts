import { z } from 'zod'
import type { Tool } from '../tool.js'
import { loadPrompt } from '../../config/prompt-loader.js'

const sectionPaths = {
  base: './prompts/characters/style/base.md',
  anti_patterns: './prompts/characters/style/anti-patterns.md',
  special_cases: './prompts/characters/style/special-cases.md',
} as const

const argsSchema = z.object({
  section: z
    .enum(['base', 'anti_patterns', 'special_cases'])
    .optional()
    .describe('可选. 不传只返回索引; 传 base / anti_patterns / special_cases 获取具体风格内容.'),
})

export const styleGuideTool: Tool<z.infer<typeof argsSchema>> = {
  name: 'style_guide',
  description: [
    '按需读取 Luna 的说话风格指南. 不传 section 只返回索引.',
    '需要基础语气用 section=base; 需要反例对照用 anti_patterns; 需要成人梗/角色扮演/做不到的事等场景用 special_cases.',
    '不要每轮都调用; 日常短回复按 system prompt 的核心语气即可.',
  ].join(' '),
  schema: argsSchema,
  async execute(args) {
    if (!args.section) {
      return { content: loadPrompt('./prompts/characters/default.md').trim() }
    }
    return { content: loadPrompt(sectionPaths[args.section]).trim() }
  },
}
