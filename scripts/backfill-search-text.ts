#!/usr/bin/env tsx
import 'dotenv/config'
import { prisma } from '../src/database/client.js'
import { segmentsToPlainText } from '../src/utils/segment-text.js'
import type { ParsedSegment } from '../src/types/message-segments.js'

const BATCH_SIZE = 100

async function main() {
  let cursor: number | undefined
  let total = 0

  console.log('Starting backfill of searchText...')

  while (true) {
    const messages = await prisma.message.findMany({
      take: BATCH_SIZE,
      ...(cursor !== undefined ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, content: true },
    })

    if (messages.length === 0) break

    for (const msg of messages) {
      const segments = msg.content as unknown as ParsedSegment[]
      const searchText = segmentsToPlainText(segments)
      await prisma.message.update({
        where: { id: msg.id },
        data: { searchText },
      })
    }

    total += messages.length
    cursor = messages[messages.length - 1]!.id
    console.log(`Processed ${total} messages`)
  }

  console.log(`Done! Total processed: ${total}`)
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
