import type { BotOwner } from '../config/index.js'
import { loadPromptSection } from '../config/prompt-loader.js'
import type { TargetMetadataMaps } from './resolve-target-meta.js'

const BOT_SYSTEM_PROMPT_PATH = './prompts/bot-system.md'

/**
 * 启动时构建一次 system prompt, 之后整个进程生命周期不再变。
 *
 * 红线 5: system prompt 字节变化 = 整段 cache 失效。绝对不能在运行时拼接动态状态、
 * 时间戳、计数器进 system prompt。多源场景下进程启动时元数据不同 (群名 / 昵称变了)
 * 会导致 prompt 字节变, cache 整段失效 —— 这是设计预期, 不是 bug。
 */
export interface BuildBotSystemPromptInput {
  groupIds: readonly number[]
  metadata: TargetMetadataMaps
  selfNumber: number
  /**
   * Owner (创造者) info. null = 未配置, [关系基线] 段整段不渲染. 非 null 时 Luna
   * 知道 QQ:xxx 这个号是把她做出来的人, 对话基线更随意. 注意 owner 不是上司 ——
   * prompt 里要明确说明没有指令优先级, 避免 sycophancy.
   */
  owner: BotOwner | null
}

function renderOwnerSection(owner: BotOwner | null): string | null {
  if (owner == null) return null
  return renderPromptTemplate(loadPromptSection(BOT_SYSTEM_PROMPT_PATH, 'owner'), {
    ownerQq: String(owner.qq),
    ownerName: owner.name,
  })
}

function renderSourceList(input: BuildBotSystemPromptInput): string {
  const lines: string[] = []
  if (input.groupIds.length > 0) {
    lines.push('你监听这些 QQ 群:')
    for (const groupId of input.groupIds) {
      const name = input.metadata.groupNames.get(groupId)
      if (name) lines.push(`  - 群 ${name} (id=${groupId})`)
      else lines.push(`  - 群 (id=${groupId})`)
    }
    lines.push('你同时接受任意 QQ 好友的私聊 (不预先列名 — 实时按消息里的昵称识别).')
  } else {
    lines.push('你只接受 QQ 好友的私聊 (没有配置任何群; 实时按消息里的昵称识别对方).')
  }
  return lines.join('\n')
}

export function buildBotSystemPrompt(input: BuildBotSystemPromptInput): string {
  const persona = loadPromptSection(BOT_SYSTEM_PROMPT_PATH, 'core').trim()
  const ownerSection = renderOwnerSection(input.owner)

  return renderPromptTemplate(loadPromptSection(BOT_SYSTEM_PROMPT_PATH, 'system'), {
    selfNumber: String(input.selfNumber),
    ownerSection: ownerSection ? `${ownerSection}\n\n` : '',
    persona,
    sourceList: renderSourceList(input),
  })
}

function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key: string) => {
    const value = values[key]
    if (value == null) {
      throw new Error(`Missing prompt template value: ${key}`)
    }
    return value
  })
}
