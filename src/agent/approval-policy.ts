import type { ApprovalManager } from './approval-manager.js'
import type { BeforeToolHook } from './tool.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

export interface ApprovalRequirement {
  reason: string
}

export type ApprovalMode = 'off' | 'thin' | 'strict'

export function classifyApprovalRequirement(
  toolName: string,
  args: unknown,
  mode: ApprovalMode = 'thin',
): ApprovalRequirement | null {
  if (mode === 'off') return null
  const action = readAction(args)
  if (toolName === 'website' && action === 'publish') {
    return { reason: '发布并推送个人网站变更' }
  }
  if (mode !== 'strict') return null
  if (toolName === 'memory' && (action === 'delete' || action === 'delete_entry')) {
    return { reason: '永久删除长期记忆' }
  }
  if (toolName === 'journal' && action === 'delete') {
    return { reason: '永久删除日记记录' }
  }
  if (toolName === 'life_journal' && action === 'delete') {
    return { reason: '永久删除 Life Journal 记录' }
  }
  if (toolName === 'workspace_file' && action === 'delete') {
    return { reason: '永久删除 workspace 文件' }
  }
  if (toolName === 'website' && action === 'delete') {
    return { reason: '删除个人网站内容' }
  }
  if (toolName === 'skill_editor' && action === 'install') {
    return { reason: '安装新的运行时 skill' }
  }
  return null
}

export function createOwnerApprovalHook(
  manager: ApprovalManager,
  additionalClassifier?: (toolName: string, args: unknown) => ApprovalRequirement | null,
  mode: ApprovalMode = 'thin',
): BeforeToolHook {
  return (ctx) => {
    if (mode === 'off') return
    const requirement = classifyApprovalRequirement(ctx.tool.name, ctx.call.args, mode)
      ?? additionalClassifier?.(ctx.tool.name, ctx.call.args)
    if (!requirement) return
    const decision = manager.authorize({
      toolName: ctx.tool.name,
      args: ctx.call.args,
      reason: requirement.reason,
    })
    if (decision.allowed) return
    if (decision.code === 'owner_not_configured') {
      const error = '该高风险操作需要 owner 审批，但 BOT_OWNER_QQ/BOT_OWNER_NAME 未配置。'
      return {
        content: JSON.stringify({ ok: false, code: 'owner_not_configured', error }),
        outcome: { ok: false, code: 'owner_not_configured', error },
      }
    }
    const request = decision.request!
    const approvalText = `批准 ${request.id}`
    return {
      content: JSON.stringify({
        ok: false,
        code: 'approval_required',
        approvalId: request.id,
        toolName: request.toolName,
        reason: request.reason,
        expiresAt: formatBeijingIso(request.expiresAt),
        ownerInstruction: `请私聊 owner 发送精确文本：${approvalText}`,
        next: 'owner 回复后用 inbox 读取该私聊 rowId，再调用 approval action=approve。审批成功后用完全相同参数重试原工具。',
      }),
      outcome: { ok: false, code: 'approval_required', error: requirement.reason },
    }
  }
}

function readAction(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const action = (args as Record<string, unknown>).action
  return typeof action === 'string' ? action : null
}
