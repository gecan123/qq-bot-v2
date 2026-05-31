import { z } from 'zod'
import type { GroupCustomization } from '../../config/group-prompts.js'
import type { TargetMetadataMaps } from '../resolve-target-meta.js'
import type { Tool } from '../tool.js'

const argsSchema = z.object({
  groupId: z.number().int().describe('要查看风格定制的 QQ 群号. 必须来自 system prompt 运行环境里列出的监听群.'),
})

type Args = z.infer<typeof argsSchema>

export interface SourceProfileDeps {
  groupIds: readonly number[]
  metadata: TargetMetadataMaps
  groupCustomizations: readonly GroupCustomization[]
}

export function createSourceProfileTool(deps: SourceProfileDeps): Tool<Args> {
  const monitoredGroupIds = new Set(deps.groupIds)
  const customById = new Map(deps.groupCustomizations.map((custom) => [custom.id, custom]))

  return {
    name: 'source_profile',
    description: [
      '按需读取某个监听群的在场风格定制.',
      '当你需要判断某个群该更安静、正常还是更主动, 或需要读取 groups.yaml 里的群口味正文时调用.',
      '不在监听范围内的 groupId 会返回错误. 未配置的群等价于 frequencyHint=normal + 空 body.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
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
