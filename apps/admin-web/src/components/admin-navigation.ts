import {
  Activity,
  BookOpenText,
  Database,
  Gauge,
  HeartPulse,
  LayoutDashboard,
  MessageCircleMore,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react'

export type NavigationPath = '/' | '/context' | '/timeline' | '/life' | '/memory' | '/qq' | '/metrics' | '/logs' | '/health' | '/operations'
export type NavigationItem = { to: NavigationPath; label: string; hint: string; icon: LucideIcon }

export const primaryNavigation: NavigationItem[] = [
  { to: '/', label: '现在', hint: '当前状态与进展', icon: LayoutDashboard },
  { to: '/qq', label: '会话', hint: 'QQ、飞书与媒体', icon: MessageCircleMore },
  { to: '/memory', label: '知识', hint: 'Memory 与 Notebook', icon: BookOpenText },
]

export const investigationNavigation: NavigationItem[] = [
  { to: '/health', label: '系统健康', hint: '完整性与运行状态', icon: ShieldCheck },
  { to: '/logs', label: '进程日志', hint: '搜索与实时 tail', icon: ScrollText },
  { to: '/context', label: 'Agent 历史', hint: '决定后续上下文的正式记录', icon: Database },
  { to: '/timeline', label: '执行追踪', hint: '模型、工具与 Ledger 诊断', icon: Activity },
  { to: '/life', label: '计划', hint: 'Schedule 与后台任务', icon: HeartPulse },
  { to: '/metrics', label: '用量指标', hint: 'Token、缓存与工具', icon: Gauge },
]

export const managementNavigation: NavigationItem[] = [
  { to: '/operations', label: '管理操作', hint: '预览、确认与审计', icon: SlidersHorizontal },
]
