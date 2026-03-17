import * as fs from 'node:fs'
import { log } from '../logger.js'

export type AgentMode = 'single' | 'heuristic' | 'always'

export interface AgentProfile {
  persona: string
  replyContextMessages?: number
  agentMode?: AgentMode
  proactivePolicy?: { enabled: boolean }
}

interface AgentConfig {
  default: AgentProfile
  groups?: Record<string, AgentProfile>
}

const DEFAULT_PROFILE: AgentProfile = {
  persona: '你是一个友好的群聊助手，请简洁地回答用户的问题。',
  replyContextMessages: 30,
  agentMode: 'single',
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

export function getAgentProfile(groupId: number): AgentProfile {
  const cfg = getConfig()
  const groupProfile = cfg.groups?.[String(groupId)]
  if (!groupProfile) return { ...DEFAULT_PROFILE, ...cfg.default }
  return { ...DEFAULT_PROFILE, ...cfg.default, ...groupProfile }
}
