import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from '../logger.js'

export interface AgentProfile {
  persona?: string
  personaFile?: string
  replyContextMessages?: number
  agentMaxSteps?: number
  /** 慢请求告警阈值（毫秒），仅告警不中断 */
  agentWarningTimeMs?: number
  /** @deprecated 保留兼容；等价于 agentWarningTimeMs */
  agentMaxTimeMs?: number
  agentMaxAnswerChars?: number
  proactivePolicy?: { enabled: boolean }
}

interface AgentConfig {
  default: AgentProfile
  groups?: Record<string, AgentProfile>
}

const DEFAULT_PERSONA = [
  '你是群聊里的常驻聊天搭子，不端着，能自然接梗，也知道什么时候收住。',
  '嘴碎程度：中等偏上。该接话时可以多一句，但不要连续刷屏，不要自我加戏。',
  '边界：不装熟到冒犯，不替别人做决定，不替自己编经历；拿不准就直接说不确定。',
  '语气：轻松、口语化、有一点幽默感；优先像真实群友说话，不要客服腔，不要官话。',
  '玩笑：可以小幅开玩笑或接梗，但遇到严肃、敏感、冲突、求助场景时立即收敛，先给明确有效的信息。',
  '收敛：当用户只是要答案、时间、结论、步骤时，短答优先，不额外铺垫。',
].join('\n')

const DEFAULT_PROFILE: AgentProfile = {
  persona: DEFAULT_PERSONA,
  replyContextMessages: 20,
}

function resolvePersona(profile: AgentProfile): string {
  if (profile.personaFile) {
    try {
      return fs.readFileSync(path.resolve(profile.personaFile), 'utf-8').trim()
    } catch {
      log.warn({ personaFile: profile.personaFile }, 'persona 文件读取失败，使用内联 persona')
    }
  }
  return profile.persona ?? DEFAULT_PERSONA
}

function loadConfig(): AgentConfig {
  try {
    const raw = fs.readFileSync('agent-config.json', 'utf-8')
    return JSON.parse(raw) as AgentConfig
  } catch {
    log.warn('agent-config.json 未找到，使用默认配置')
    return { default: DEFAULT_PROFILE }
  }
}

let cachedConfig: AgentConfig | undefined

function getConfig(): AgentConfig {
  if (!cachedConfig) cachedConfig = loadConfig()
  return cachedConfig
}

export function getAgentProfile(groupId: number): AgentProfile & { persona: string } {
  const cfg = getConfig()
  const groupProfile = cfg.groups?.[String(groupId)]
  const merged: AgentProfile = groupProfile
    ? { ...DEFAULT_PROFILE, ...cfg.default, ...groupProfile }
    : { ...DEFAULT_PROFILE, ...cfg.default }
  return { ...merged, persona: resolvePersona(merged) }
}
