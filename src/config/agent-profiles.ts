import * as fs from 'node:fs'
import * as path from 'node:path'
import { createLogger } from '../logger.js'
import { loadPrompt } from './prompt-loader.js'

const log = createLogger('CONFIG')

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
}

interface AgentConfig {
  default: AgentProfile
  groups?: Record<string, AgentProfile>
}

const DEFAULT_PERSONA = loadPrompt('./prompts/characters/default.md')

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
