import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { ChevronDown, Menu, ShieldCheck, Sparkles } from 'lucide-react'
import {
  investigationNavigation,
  managementNavigation,
  primaryNavigation,
  type NavigationItem,
  type NavigationPath,
} from './admin-navigation.js'

const investigationPaths = new Set<NavigationPath>(investigationNavigation.map(item => item.to))

export function AdminShell() {
  const pathname = useRouterState({ select: state => state.location.pathname })
  const isInvestigating = investigationPaths.has(pathname as NavigationPath)
  const isManaging = pathname.startsWith('/operations')

  return (
    <div className="admin-frame">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-inner">
          <Brand />

          <div className="desktop-navigation">
            <div className="nav-caption">日常</div>
            <Navigation items={primaryNavigation} label="日常导航" />

            <details className="nav-disclosure" open={isInvestigating || undefined}>
              <summary className={isInvestigating ? 'nav-group-toggle nav-group-toggle--active' : 'nav-group-toggle'}>
                <span className="nav-icon"><ShieldCheck size={17} strokeWidth={1.8} /></span>
                <span className="min-w-0 flex-1"><span className="nav-label">调查</span><span className="nav-hint">健康、日志与底层证据</span></span>
                <ChevronDown className="nav-chevron" size={14} />
              </summary>
              <Navigation items={investigationNavigation} label="调查导航" nested />
            </details>

            <div className="nav-caption">维护</div>
            <Navigation items={managementNavigation} label="管理操作导航" management />
          </div>

          <MobileNavigation key={pathname} isInvestigating={isInvestigating} isManaging={isManaging} />

          <div className="sidebar-foot">
            <div className="sidebar-foot-icon"><ShieldCheck size={15} /></div>
            <div><strong>Local only</strong><span>观察只读 · 操作需确认</span></div>
          </div>
        </div>
      </aside>
      <main className="admin-main">
        <div className="admin-content"><Outlet /></div>
      </main>
    </div>
  )
}

function Brand() {
  return (
    <div className="brand-lockup">
      <div className="brand-mark" aria-hidden="true"><Sparkles size={18} strokeWidth={2.2} /></div>
      <div className="min-w-0">
        <p className="brand-name">Luna Admin</p>
        <p className="brand-subtitle">本机观察台</p>
      </div>
      <span className="mode-pill"><span className="live-dot" />仅本机</span>
    </div>
  )
}

function Navigation({ items, label, nested = false, management = false }: {
  items: NavigationItem[]
  label: string
  nested?: boolean
  management?: boolean
}) {
  return (
    <nav className={`admin-nav${nested ? ' admin-nav--nested' : ''}`} aria-label={label}>
      {items.map(item => <NavigationLink key={item.to} item={item} management={management} />)}
    </nav>
  )
}

function NavigationLink({ item, management = false }: { item: NavigationItem; management?: boolean }) {
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.to === '/' }}
      className={management ? 'nav-link nav-link--management' : 'nav-link'}
      activeProps={{ className: management ? 'nav-link nav-link--management nav-link-active' : 'nav-link nav-link-active' }}
    >
      <span className="nav-icon"><Icon size={17} strokeWidth={1.8} /></span>
      <span className="min-w-0 flex-1"><span className="nav-label">{item.label}</span><span className="nav-hint">{item.hint}</span></span>
    </Link>
  )
}

function MobileNavigation({ isInvestigating, isManaging }: { isInvestigating: boolean; isManaging: boolean }) {
  return (
    <nav className="mobile-navigation" aria-label="移动端导航">
      {primaryNavigation.map(item => {
        const Icon = item.icon
        return <Link key={item.to} to={item.to} activeOptions={{ exact: item.to === '/' }} className="mobile-nav-link" activeProps={{ className: 'mobile-nav-link mobile-nav-link--active' }}><Icon size={17} /><span>{item.label}</span></Link>
      })}
      <details className="mobile-more">
        <summary className={(isInvestigating || isManaging) ? 'mobile-nav-link mobile-nav-link--active' : 'mobile-nav-link'}><Menu size={17} /><span>更多</span></summary>
        <div className="mobile-more-menu">
          <p>调查</p>
          {investigationNavigation.map(item => <NavigationLink key={item.to} item={item} />)}
          <p>维护</p>
          {managementNavigation.map(item => <NavigationLink key={item.to} item={item} management />)}
        </div>
      </details>
    </nav>
  )
}
