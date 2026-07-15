import 'dotenv/config'
import { prisma } from '../src/database/client.js'
import {
  checkAgentLedger,
  createPrismaAgentLedgerCheckSource,
  type AgentLedgerCheckPrismaClient,
} from '../src/ops/agent-ledger-check.js'

await prisma.$connect()
try {
  const report = await checkAgentLedger(createPrismaAgentLedgerCheckSource(
    prisma as unknown as AgentLedgerCheckPrismaClient,
  ))
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.ok) process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
