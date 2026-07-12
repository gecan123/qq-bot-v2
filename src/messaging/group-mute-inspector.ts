import { napcat } from '../bot/napcat.js'
import { config } from '../config/index.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

export interface GroupMuteInspection {
  muted: boolean
  mutedUntil?: string
}

export interface GroupMuteInspector {
  inspect(groupId: number): Promise<GroupMuteInspection>
}

interface GroupShutEntry {
  qid: string
  shutUpTime: number
}

interface GroupMuteInspectorDeps {
  selfNumber: number
  loadGroupShutList(groupId: number): Promise<readonly GroupShutEntry[]>
}

export function createGroupMuteInspector(deps: GroupMuteInspectorDeps): GroupMuteInspector {
  return {
    async inspect(groupId) {
      const entries = await deps.loadGroupShutList(groupId)
      const selfEntry = entries.find((entry) => entry.qid === String(deps.selfNumber))
      if (!selfEntry) return { muted: false }

      const mutedUntilDate = new Date(selfEntry.shutUpTime * 1000)
      const mutedUntil = Number.isFinite(mutedUntilDate.getTime())
        ? formatBeijingIso(mutedUntilDate)
        : undefined
      return {
        muted: true,
        ...(mutedUntil ? { mutedUntil } : {}),
      }
    },
  }
}

export const groupMuteInspector = createGroupMuteInspector({
  selfNumber: config.selfNumber,
  loadGroupShutList: async (groupId) => napcat.get_group_shut_list({ group_id: groupId }),
})
