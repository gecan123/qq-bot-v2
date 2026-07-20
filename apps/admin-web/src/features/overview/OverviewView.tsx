import {
  AlertTriangle,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  LoaderCircle,
  Wrench,
  X,
} from 'lucide-react'
import { JsonBlock, PageHeader, Panel, StatCard, StatGrid, StatusBadge, WarningList } from '../../components/AdminUi.js'
import { formatCount, formatDuration, formatPercent, formatTimestamp } from '../../lib/format.js'
import type { OverviewSnapshot } from './overview.schema.js'

type OverviewViewProps = { snapshot: OverviewSnapshot; isRefreshing: boolean; refreshFailed: boolean }
type ActivityTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral'

const phaseLabels: Record<OverviewSnapshot['activity']['phase'], string> = {
  starting: '正在启动',
  thinking: '正在思考',
  tool: '正在使用工具',
  resting: '正在短暂休息',
  committing: '正在保存结果',
  waiting: '等待新事件',
  error: '本轮遇到错误',
  stopping: '正在停止',
  stopped: '已停止',
  unavailable: '实时状态不可用',
}

export function OverviewView({ snapshot, isRefreshing, refreshFailed }: OverviewViewProps) {
  const usage = snapshot.latestAgentUsage
  const activity = snapshot.activity
  const status = phaseLabels[activity.phase]
  const tone = phaseTone(activity.phase)
  const currentStep = describeCurrentStep(snapshot)
  const nextStep = describeNextStep(snapshot)

  return <>
    <PageHeader
      title="现在"
      description="先看 Agent 为什么醒来、此刻正在做什么和下一项可检查结果；底层 Ledger 与原始事件保留为下钻证据。"
      generatedAt={snapshot.generatedAt}
      isRefreshing={isRefreshing}
      refreshFailed={refreshFailed}
    />

    <section className={`current-activity current-activity--${tone}`} aria-label="Agent 当前活动">
      <div className="current-activity-head">
        <div className="current-status">
          <span className="current-status-icon" aria-hidden="true">{phaseIcon(activity.phase)}</span>
          <div>
            <p className="current-status-label">A 当前状态</p>
            <h2>{status}</h2>
          </div>
        </div>
        <div className="current-duration">
          <Clock3 size={13} />
          {activity.phaseStartedAt
            ? `已持续 ${formatDuration(Math.max(0, Date.parse(snapshot.generatedAt) - Date.parse(activity.phaseStartedAt)))}`
            : '等待 Bot Runtime 发布状态'}
        </div>
      </div>

      <div className="current-activity-body">
        <div className="current-primary">
          <p className="current-eyebrow">当前目标</p>
          <h3>{snapshot.goal?.objective ?? '暂无持久 Goal'}</h3>
          {snapshot.goal && <div className="current-goal-meta"><StatusBadge tone={snapshot.goal.status === 'active' ? 'good' : 'warn'}>{snapshot.goal.status}</StatusBadge><span>{formatCount(snapshot.goal.tokensUsed)} tokens · revision {snapshot.goal.revision}</span></div>}

          <div className="current-step">
            <span className="current-step-marker" aria-hidden="true" />
            <div><p>当前步骤</p><strong>{currentStep}</strong></div>
          </div>

          {activity.activeTools.length > 1 && (
            <div className="active-tool-list" aria-label="并行执行的工具">
              {activity.activeTools.map(tool => <StatusBadge key={tool.toolCallId} tone="info">{tool.toolName}</StatusBadge>)}
            </div>
          )}
        </div>

        <dl className="current-facts">
          <CurrentFact label="当前会话" value={formatRuntime(snapshot)} />
          <CurrentFact label="唤醒原因" value={activity.trigger?.label ?? '没有可用的结构化唤醒原因'} />
          <CurrentFact label="下一项可检查结果" value={nextStep} />
          <CurrentFact label="运行位置" value={activity.roundIndex === null ? '—' : `Round ${activity.roundIndex}`} />
        </dl>
      </div>

      {!activity.available && (
        <div className="activity-unavailable"><AlertTriangle size={15} /><span>Bot 尚未发布实时活动面，或该状态属于已经停止的旧进程。重启 Bot 后这里会开始显示实时阶段；下方已完成记录仍可查看。</span></div>
      )}
    </section>

    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,.8fr)]">
      <Panel title="最近进展" description="一个已完成工具调用对应一条人话进展；参数、ID 和 round 默认折叠。">
        {snapshot.recentActions.length === 0
          ? <div className="empty-state"><span className="empty-state-dot" />暂无已完成工具记录</div>
          : <ol className="activity-feed">
              {snapshot.recentActions.map(action => (
                <li key={action.id} className="activity-feed-item">
                  <span className={`activity-feed-icon ${action.ok ? 'activity-feed-icon--ok' : 'activity-feed-icon--bad'}`} aria-hidden="true">{action.ok ? <Check size={13} /> : <X size={13} />}</span>
                  <div className="activity-feed-content">
                    <div className="activity-feed-heading"><strong>{action.title}</strong><time>{formatTimestamp(action.at)}</time></div>
                    <p>{action.detail}</p>
                    <div className="activity-feed-meta"><span>{formatDuration(action.durationMs)}</span>{action.sideEffect && <StatusBadge tone="warn">产生副作用</StatusBadge>}{!action.ok && <StatusBadge tone="bad">失败</StatusBadge>}</div>
                    <details className="activity-evidence">
                      <summary><ChevronRight size={12} />技术细节</summary>
                      <JsonBlock value={{ tool: action.toolName, toolCallId: action.toolCallId, roundIndex: action.roundIndex, args: action.argsSummary }} variant="preview" />
                    </details>
                  </div>
                </li>
              ))}
            </ol>}
      </Panel>

      <div className="space-y-4">
        <Panel title="当前承诺" description="只使用持久 Goal 的结构化 commitment，不从日志猜测意图。">
          {snapshot.goal?.currentCommitment
            ? <dl className="commitment-card"><CurrentFact label="动作" value={snapshot.goal.currentCommitment.action} /><CurrentFact label="为什么" value={snapshot.goal.currentCommitment.reason} /><CurrentFact label="预期证据" value={snapshot.goal.currentCommitment.expectedEvidence} /></dl>
            : <div className="empty-state"><span className="empty-state-dot" />当前没有结构化 commitment</div>}
        </Panel>
        <Panel title="等待条件">
          <dl className="commitment-card">
            <CurrentFact label="当前说明" value={activity.detail ?? '—'} />
            <CurrentFact label="最晚等待到" value={formatTimestamp(activity.waitUntil)} />
          </dl>
        </Panel>
      </div>
    </div>

    <div className="mt-4"><StatGrid>
      <StatCard label="Ledger" value={formatCount(snapshot.ledger.entryCount)} detail={`Head #${snapshot.ledger.headEntryId ?? '—'} · ${snapshot.ledger.latestEntryType ?? '无 entry'}`} />
      <StatCard label="Tools · 24h" value={formatCount(snapshot.tools24h.calls)} detail={`${snapshot.tools24h.failed} failed`} tone={snapshot.tools24h.failed ? 'warn' : 'good'} />
      <StatCard label="Latest input" value={formatCount(usage?.inputTokens ?? null)} detail={usage?.model ?? '暂无 agent.chat usage'} />
      <StatCard label="Cache hit" value={formatPercent(usage?.cacheHitRate ?? null)} detail={`${formatCount(usage?.cachedTokens ?? null)} cached`} />
    </StatGrid></div>

    <Panel className="mt-4" title="技术下钻" description="只有需要核对证据或排障时，再进入底层页面。"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Jump to="/context" title="Ledger 调试" detail="投影边界、entry 构成、最近原始历史" />
      <Jump to="/timeline" title="原始事件" detail="工具、token 与 ledger 的逐条记录" />
      <Jump to="/life" title="生命状态" detail="Goal、Agenda、Schedule、后台任务" />
      <Jump to="/health" title="系统健康" detail="进程提示、DB、完整性、迁移" />
    </div></Panel>
    <WarningList warnings={snapshot.warnings} />
  </>
}

function CurrentFact({ label, value }: { label: string; value: string }) {
  return <div className="current-fact"><dt>{label}</dt><dd>{value}</dd></div>
}

function Jump({ to, title, detail }: { to: '/context' | '/timeline' | '/life' | '/health'; title: string; detail: string }) {
  return <a href={to} className="investigation-link"><div className="flex items-center justify-between gap-2"><strong>{title}</strong><StatusBadge tone="info">打开</StatusBadge></div><p>{detail}</p></a>
}

function describeCurrentStep(snapshot: OverviewSnapshot): string {
  const tool = snapshot.activity.activeTools[0]
  if (tool) return describeActiveTool(tool.toolName, tool.argsSummary)
  if (snapshot.goal?.currentCommitment) return snapshot.goal.currentCommitment.action
  return snapshot.activity.detail ?? (snapshot.activity.available ? '正在等待 Agent 更新下一步' : '无法确认实时步骤')
}

function describeNextStep(snapshot: OverviewSnapshot): string {
  if (snapshot.goal?.currentCommitment) return snapshot.goal.currentCommitment.expectedEvidence
  if (snapshot.activity.phase === 'waiting') return snapshot.activity.detail ?? '等待新的注意事件'
  if (snapshot.activity.activeTools.length > 0) return '工具完成后保存结果，再由 Agent 决定下一步'
  return '等待下一条结构化活动状态'
}

function describeActiveTool(toolName: string, args: unknown): string {
  const record = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
  const action = typeof record.action === 'string' ? record.action : null
  switch (toolName) {
    case 'inbox': return '正在读取 QQ 消息'
    case 'send_message': return '正在向当前 QQ 会话发送消息'
    case 'web_search': return '正在搜索网络信息'
    case 'fetch_content': return '正在读取外部内容'
    case 'browser': return action === 'open' ? '正在打开网页' : '正在操作浏览器'
    case 'pause':
    case 'rest': return '正在短暂休息'
    case 'goal': return '正在读取或更新持久 Goal'
    default: return `正在执行 ${toolName}`
  }
}

function formatRuntime(snapshot: OverviewSnapshot): string {
  if (!snapshot.runtime.available) return 'Runtime 状态缺失'
  if (!snapshot.runtime.focus) return '未选择 QQ 会话'
  return snapshot.runtime.focus.type === 'group' ? `群 ${snapshot.runtime.focus.id}` : `私聊 ${snapshot.runtime.focus.id}`
}

function phaseTone(phase: OverviewSnapshot['activity']['phase']): ActivityTone {
  if (phase === 'error' || phase === 'unavailable') return 'bad'
  if (phase === 'waiting' || phase === 'resting' || phase === 'stopping') return 'warn'
  if (phase === 'thinking' || phase === 'tool' || phase === 'committing' || phase === 'starting') return 'info'
  if (phase === 'stopped') return 'neutral'
  return 'good'
}

function phaseIcon(phase: OverviewSnapshot['activity']['phase']) {
  if (phase === 'thinking' || phase === 'committing' || phase === 'starting') return <LoaderCircle className="animate-spin" size={20} />
  if (phase === 'tool') return <Wrench size={20} />
  if (phase === 'error' || phase === 'unavailable') return <AlertTriangle size={20} />
  return <Circle size={18} />
}
