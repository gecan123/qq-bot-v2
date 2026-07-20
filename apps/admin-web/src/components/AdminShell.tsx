import { Link, Outlet } from '@tanstack/react-router'
import {
  Activity,
  BookOpenText,
  Database,
  Gauge,
  HeartPulse,
  LayoutDashboard,
  MessageCircleMore,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'

const navigation: Array<{ to: '/' | '/context' | '/timeline' | '/life' | '/memory' | '/qq' | '/metrics' | '/health'; label: string; hint: string; icon: LucideIcon }> = [
  { to: '/', label: '现在', hint: 'Live cockpit', icon: LayoutDashboard },
  { to: '/context', label: 'Ledger 调试', hint: 'Canonical', icon: Database },
  { to: '/timeline', label: '原始事件', hint: 'Trace', icon: Activity },
  { to: '/life', label: '生命状态', hint: 'Goal & agenda', icon: HeartPulse },
  { to: '/memory', label: 'Memory / Life', hint: 'Knowledge', icon: BookOpenText },
  { to: '/qq', label: 'QQ / Media', hint: 'Inbox', icon: MessageCircleMore },
  { to: '/metrics', label: '指标', hint: 'Usage', icon: Gauge },
  { to: '/health', label: '系统健康', hint: 'Integrity', icon: ShieldCheck },
]

export function AdminShell() {
  return (
    <div className="admin-frame">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-inner">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true"><Sparkles size={18} strokeWidth={2.2} /></div>
            <div className="min-w-0">
              <p className="brand-name">Luna Console</p>
              <p className="brand-subtitle">Agent observatory</p>
            </div>
            <span className="read-only-pill"><span className="live-dot" />只读</span>
          </div>

          <div className="nav-caption">观察面</div>
          <nav className="admin-nav" aria-label="管理台导航">
            {navigation.map(item => {
              const Icon = item.icon
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  activeOptions={{ exact: item.to === '/' }}
                  className="nav-link"
                  activeProps={{ className: 'nav-link nav-link-active' }}
                >
                  <span className="nav-icon"><Icon size={17} strokeWidth={1.8} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="nav-label">{item.label}</span>
                    <span className="nav-hint">{item.hint}</span>
                  </span>
                </Link>
              )
            })}
          </nav>

          <div className="sidebar-foot">
            <div className="sidebar-foot-icon"><ShieldCheck size={15} /></div>
            <div><strong>Flight recorder</strong><span>无写入与控制操作</span></div>
          </div>
        </div>
      </aside>
      <main className="admin-main">
        <div className="admin-content"><Outlet /></div>
      </main>
    </div>
  )
}
