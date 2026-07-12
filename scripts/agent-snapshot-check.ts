import 'dotenv/config'
import { prisma } from '../src/database/client.js'
import { validateBotSnapshotIntegrity } from '../src/agent/snapshot-integrity.js'
import type { PersistedAgentSnapshot } from '../src/agent/agent-context.types.js'
import { formatBeijingIso } from '../src/utils/beijing-time.js'

try {
  const row = await prisma.botAgentSnapshot.findUnique({
    where: { id: 1 },
  })

  if (!row) {
    console.log(JSON.stringify({
      ok: true,
      status: 'empty',
      message: 'bot_agent_snapshot row id=1 does not exist',
    }, null, 2))
    process.exit(0)
  }

  const result = validateBotSnapshotIntegrity({
    snapshot: row.contextSnapshot as unknown as PersistedAgentSnapshot,
    mailboxCursors: row.mailboxCursors,
  })

  console.log(JSON.stringify({
    status: 'checked',
    snapshotUpdatedAt: formatBeijingIso(row.updatedAt),
    ...result,
  }, null, 2))

  if (!result.ok) process.exit(1)
} finally {
  await prisma.$disconnect()
}
