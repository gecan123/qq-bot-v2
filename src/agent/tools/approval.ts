import { z } from 'zod'
import type { ApprovalManager } from '../approval-manager.js'
import type { Tool } from '../tool.js'
import { formatBeijingIso } from '../../utils/beijing-time.js'

const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('status'), approvalId: z.string().min(1) }),
  z.object({
    action: z.literal('approve'),
    approvalId: z.string().min(1),
    messageRowId: z.number().int().positive()
      .describe('owner 私聊“批准 <approvalId>”那条消息的 inbox rowId。'),
  }),
  z.object({ action: z.literal('cancel'), approvalId: z.string().min(1) }),
])

type Args = z.infer<typeof argsSchema>

export function createApprovalTool(manager: ApprovalManager): Tool<Args> {
  return {
    name: 'approval',
    description: [
      '管理高风险工具审批。高风险调用被阻断后，先把返回的精确批准文本私聊给 owner。',
      'owner 回复后，用 inbox 读取该私聊的 rowId，再调用 action=approve；后端会验证发送者、私聊来源、时间和完整文本。',
      '批准只匹配原 tool + args，且只消费一次；Agent 不能自行批准。',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        if (args.action === 'list') {
          return { content: JSON.stringify({ ok: true, approvals: manager.list().map(renderApproval) }) }
        }
        if (args.action === 'status') {
          const approval = manager.get(args.approvalId)
          return { content: JSON.stringify(approval
            ? { ok: true, approval: renderApproval(approval) }
            : { ok: false, code: 'not_found' }) }
        }
        if (args.action === 'cancel') {
          const cancelled = manager.cancel(args.approvalId)
          return {
            content: JSON.stringify({ ok: cancelled, approvalId: args.approvalId }),
            outcome: { ok: cancelled, code: cancelled ? 'cancelled' : 'not_found' },
          }
        }
        const approval = await manager.approve(args)
        return {
          content: JSON.stringify({
            ok: true,
            approval: renderApproval(approval),
            next: '现在用完全相同的参数重试原高风险工具；批准将在执行前一次性消费。',
          }),
          outcome: { ok: true, code: 'approved' },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: JSON.stringify({ ok: false, code: 'approval_rejected', error: message }),
          outcome: { ok: false, code: 'approval_rejected', error: message },
        }
      }
    },
  }
}

function renderApproval(approval: ReturnType<ApprovalManager['list']>[number]) {
  return {
    approvalId: approval.id,
    toolName: approval.toolName,
    reason: approval.reason,
    status: approval.status,
    createdAt: formatBeijingIso(approval.createdAt),
    expiresAt: formatBeijingIso(approval.expiresAt),
    ...(approval.approvedByMessageRowId != null
      ? { approvedByMessageRowId: approval.approvedByMessageRowId }
      : {}),
  }
}
