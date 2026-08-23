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
  { to: '/memory', label: '知识', hint: 'Memory 与 Life', icon: BookOpenText },
]

export const investigationNavigation: NavigationItem[] = [
  { to: '/health', label: '系统健康', hint: '完整性与运行状态', icon: ShieldCheck },
  { to: '/logs', label: '进程日志', hint: '搜索与实时 tail', icon: ScrollText },
  { to: '/timeline', label: '事件时间线', hint: '逐条活动证据', icon: Activity },
  { to: '/context', label: 'Ledger', hint: 'Context 与 canonical', icon: Database },
  { to: '/life', label: 'Goal 与计划', hint: 'Agenda 与后台任务', icon: HeartPulse },
  { to: '/metrics', label: '用量指标', hint: 'Token、缓存与工具', icon: Gauge },
]

export const managementNavigation: NavigationItem[] = [
  { to: '/operations', label: '管理操作', hint: '预览、确认与审计', icon: SlidersHorizontal },
]
