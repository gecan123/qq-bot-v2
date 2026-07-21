import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldAlert,
  Wrench,
  XCircle,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { JsonBlock, PageHeader, Panel, StatusBadge } from '../../components/AdminUi.js'
import { formatTimestamp } from '../../lib/format.js'
import type {
  OperationPreview,
  OperationRequest,
  OperationRun,
  OperationStartRequest,
  OperationsSnapshot,
} from './operations.schema.js'

const operationCards: Array<{
  operation: OperationRequest['operation']
  title: string
  description: string
}> = [
  {
    operation: 'reset_state',
    title: '重置 Agent 状态',
    description: '删除 context、knowledge 或两者；不会自动恢复。',
  },
  {
    operation: 'migrate_memory_v2',
    title: '迁移 Memory V2',
    description: '预览文件升级、人物记忆移动与隔离计划。',
  },
  {
    operation: 'canonicalize_memory',
    title: '归并 Memory 文件',
    description: '把 self/topic 文件归并到固定 canonical 目标。',
  },
  {
    operation: 'migrate_state_language',
    title: '迁移长期状态语言',
    description: '通过 LLM 分批把长期状态的人类可读叙述迁移为中文。',
  },
]

export interface OperationsViewProps {
  snapshot: OperationsSnapshot
  preview: OperationPreview | null
  run: OperationRun | null
  isRefreshing: boolean
  isPreviewing: boolean
  isStarting: boolean
  error: string | null
  onPreview(request: OperationRequest): void | Promise<void>
  onExecute(input: OperationStartRequest): void | Promise<void>
}

export function OperationsView({
  snapshot,
  preview,
  run,
  isRefreshing,
  isPreviewing,
  isStarting,
  error,
  onPreview,
  onExecute,
}: OperationsViewProps) {
  const [operation, setOperation] = useState<OperationRequest['operation']>(
    preview?.request.operation ?? 'reset_state',
  )
  const [scope, setScope] = useState<'context' | 'knowledge' | 'all'>(
    preview?.request.operation === 'reset_state' ? preview.request.scope : 'context',
  )
  const [confirmation, setConfirmation] = useState('')
  const [clock, setClock] = useState(() => Date.now())
  const currentRun = run ?? snapshot.activeRun

  useEffect(() => {
    setConfirmation('')
  }, [preview])

  useEffect(() => {
    if (!preview) return undefined
    const expiresAt = Date.parse(preview.expiresAt)
    const delay = expiresAt - Date.now()
    if (delay <= 0) {
      setClock(Date.now())
      return undefined
    }
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.min(delay + 1, 2_147_000_000),
    )
    return () => window.clearTimeout(timer)
  }, [preview])

  const request: OperationRequest = operation === 'reset_state'
    ? { operation, scope }
    : { operation }
  const previewMatchesSelection = preview !== null && requestsEqual(preview.request, request)
  const previewCurrent = previewMatchesSelection
    && Date.parse(preview.expiresAt) > Math.max(Date.parse(snapshot.generatedAt), clock)
  const botStopped = snapshot.bot.stopped
  const runActive = currentRun?.status === 'queued' || currentRun?.status === 'running'
  const canExecute = Boolean(
    preview
    && previewCurrent
    && preview.payload.needed
    && botStopped
    && confirmation === preview.confirmationPhrase
    && !runActive
    && !isStarting,
  )

  return <>
    <PageHeader
      title="管理操作"
      description="只允许四种固定维护操作。每次写入都必须先预览、确认 Bot 已停止、输入服务端短语，并通过执行前的二次状态校验。"
      generatedAt={snapshot.generatedAt}
      isRefreshing={isRefreshing}
    />

    <section className="operation-grid" aria-label="固定管理操作">
      {operationCards.map(card => (
        <button
          key={card.operation}
          type="button"
          className={`operation-card ${operation === card.operation ? 'operation-card--selected' : ''}`}
          onClick={() => {
            setOperation(card.operation)
            setConfirmation('')
          }}
        >
          <span className="operation-card-icon"><Wrench size={17} /></span>
          <strong>{card.title}</strong>
          <span>{card.description}</span>
          {preview?.request.operation === card.operation && !preview.payload.needed && (
            <StatusBadge tone="good">无需执行</StatusBadge>
          )}
        </button>
      ))}
    </section>

    <div className="operation-layout">
      <div className="space-y-4">
        <Panel title="生成只读预览" description="预览不会创建备份、修改数据库或写入长期状态。">
          {operation === 'reset_state' && (
            <label className="operation-field">
              <span>重置范围</span>
              <select
                aria-label="重置范围"
                value={scope}
                onChange={event => {
                  setScope(event.target.value as typeof scope)
                  setConfirmation('')
                }}
              >
                <option value="context">context · Ledger / Runtime / Goal</option>
                <option value="knowledge">knowledge · Memory / Journal / Life / Notebook</option>
                <option value="all">all · context + knowledge</option>
              </select>
            </label>
          )}
          <button
            type="button"
            className="operation-button operation-button--secondary"
            disabled={isPreviewing || runActive}
            onClick={() => void onPreview(request)}
          >
            {isPreviewing
              ? <><LoaderCircle className="animate-spin" size={15} />正在生成预览</>
              : <><RefreshCw size={15} />生成预览</>}
          </button>
        </Panel>

        <Panel title="预览详情" description="服务端只返回有界统计、固定路径和 warning 摘要。">
          {!preview
            ? <div className="empty-state"><span className="empty-state-dot" />请选择操作并生成预览</div>
            : !previewMatchesSelection
              ? <div className="empty-state"><span className="empty-state-dot" />当前选择已变化，请重新生成预览</div>
              : !previewCurrent
                ? <div className="empty-state"><span className="empty-state-dot" />预览已过期，请重新生成预览</div>
            : <div className="operation-preview">
                <div className="operation-preview-head">
                  <StatusBadge tone={preview.payload.needed ? 'warn' : 'good'}>
                    {preview.payload.needed ? '需要执行' : '无需执行'}
                  </StatusBadge>
                  <span>有效至 {formatTimestamp(preview.expiresAt)}</span>
                </div>
                <JsonBlock value={preview.payload} variant="preview" />
                {preview.request.operation === 'reset_state' && (
                  <div className="operation-danger-note">
                    <ShieldAlert size={16} />
                    <span>Reset 会删除所选范围，且没有自动恢复路径。执行前请独立确认影响范围。</span>
                  </div>
                )}
              </div>}
        </Panel>
      </div>

      <div className="space-y-4">
        <Panel title="停机与确认" description="WebAdmin 不会替你停止或重启 Bot。">
          <div className={`bot-guard ${botStopped ? 'bot-guard--stopped' : 'bot-guard--running'}`}>
            {botStopped ? <CheckCircle2 size={17} /> : <CircleStop size={17} />}
            <div>
              <strong>{botStopped ? 'Bot 已停止' : `Bot 仍在运行 · PID ${snapshot.bot.pid}`}</strong>
              <span>{botStopped ? '执行时仍会再次检查进程。' : '请在终端手动停止 Bot，再重新生成预览。'}</span>
            </div>
          </div>

          {previewCurrent && preview && <>
            <div className="confirmation-copy">
              <span>请输入以下确认短语</span>
              <code>{preview.confirmationPhrase}</code>
            </div>
            <label className="operation-field">
              <span>确认短语</span>
              <input
                aria-label="确认短语"
                value={confirmation}
                autoComplete="off"
                spellCheck={false}
                onChange={event => setConfirmation(event.target.value)}
              />
            </label>
          </>}

          {error && (
            <div className="operation-error" role="alert">
              <AlertTriangle size={16} />
              <span>{error.includes('preview_stale') || error.includes('preview_expired')
                ? '预览已过期或状态已变化，请重新生成预览。'
                : error.slice(0, 500)}</span>
            </div>
          )}

          <button
            type="button"
            className="operation-button operation-button--danger"
            disabled={!canExecute}
            onClick={() => preview && void onExecute({
              previewId: preview.id,
              confirmation,
            })}
          >
            {isStarting
              ? <><LoaderCircle className="animate-spin" size={15} />正在创建任务</>
              : <><Play size={15} />执行操作</>}
          </button>
        </Panel>

        <RunPanel run={currentRun} />
      </div>
    </div>

    <Panel className="mt-4" title="最近操作" description="这里只显示有界结果摘要；完整 transition 审计保存在本机 logs。">
      {snapshot.recentRuns.length === 0
        ? <div className="empty-state"><span className="empty-state-dot" />暂无已完成管理操作</div>
        : <ol className="operation-history">
            {snapshot.recentRuns.map(item => (
              <li key={item.id}>
                <StatusBadge tone={runTone(item.status)}>{runLabel(item.status)}</StatusBadge>
                <strong>{operationTitle(item.request.operation)}</strong>
                <time>{formatTimestamp(item.finishedAt ?? item.createdAt)}</time>
                {runBackupDir(item) && <code>{runBackupDir(item)}</code>}
              </li>
            ))}
          </ol>}
    </Panel>
  </>
}

function RunPanel({ run }: { run: OperationRun | null }) {
  return <Panel title="当前任务" description="页面关闭不会取消底层操作；WebAdmin 重启后未完成任务会标记为 interrupted。">
    {!run
      ? <div className="empty-state"><span className="empty-state-dot" />当前没有管理任务</div>
      : <div className="operation-run">
          <div className="operation-run-title">
            {runIcon(run.status)}
            <div><strong>{runLabel(run.status)}</strong><span>{operationTitle(run.request.operation)}</span></div>
          </div>
          {run.progress && (
            <div className="operation-progress">
              <div><span>{run.progress.phase}</span><strong>{run.progress.completed} / {run.progress.total}</strong></div>
              <progress value={run.progress.completed} max={Math.max(1, run.progress.total)} />
            </div>
          )}
          {run.status === 'succeeded' && <ResultSummary run={run} />}
          {run.status === 'failed' && (
            <div className="operation-error">
              <XCircle size={16} />
              <div>
                <span>{run.error?.message ?? '操作失败'}</span>
                {run.error?.backupDir && <code>{run.error.backupDir}</code>}
              </div>
            </div>
          )}
          {run.status === 'interrupted' && <div className="operation-error operation-error--warn"><AlertTriangle size={16} /><span>任务随 WebAdmin 进程退出而中断；请检查备份和当前状态后再决定是否重试。</span></div>}
        </div>}
  </Panel>
}

function ResultSummary({ run }: { run: OperationRun }) {
  if (!run.result) return null
  const backupDir = 'backupDir' in run.result ? run.result.backupDir : null
  return <div className="operation-success">
    <CheckCircle2 size={16} />
    <div><strong>结果已通过 schema 校验并持久化</strong>{backupDir && <code>{backupDir}</code>}</div>
  </div>
}

function runIcon(status: OperationRun['status']) {
  if (status === 'queued' || status === 'running') return <LoaderCircle className="animate-spin" size={19} />
  if (status === 'succeeded') return <CheckCircle2 size={19} />
  if (status === 'failed') return <XCircle size={19} />
  return <AlertTriangle size={19} />
}

function runLabel(status: OperationRun['status']): string {
  switch (status) {
    case 'queued': return '等待执行'
    case 'running': return '正在执行'
    case 'succeeded': return '执行成功'
    case 'failed': return '执行失败'
    case 'interrupted': return '执行被中断'
  }
}

function runTone(status: OperationRun['status']): 'neutral' | 'good' | 'warn' | 'bad' | 'info' {
  if (status === 'succeeded') return 'good'
  if (status === 'failed') return 'bad'
  if (status === 'interrupted') return 'warn'
  return 'info'
}

function operationTitle(operation: OperationRequest['operation']): string {
  return operationCards.find(card => card.operation === operation)?.title ?? operation
}

function runBackupDir(run: OperationRun): string | null {
  if (run.result && 'backupDir' in run.result) return run.result.backupDir
  return run.error?.backupDir ?? null
}

function requestsEqual(left: OperationRequest, right: OperationRequest): boolean {
  return left.operation === right.operation
    && (left.operation !== 'reset_state'
      || (right.operation === 'reset_state' && left.scope === right.scope))
}
