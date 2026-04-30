#!/usr/bin/env tsx
import 'dotenv/config'
import { prisma } from '../src/database/client.js'
import { config } from '../src/config/index.js'
import { parseV2exFeedTargets, pollV2exFeed } from '../src/curiosity/v2ex-connector.js'

async function main() {
  const feedArg = process.argv[2]
  const feeds = parseV2exFeedTargets(feedArg ?? config.v2exForum.feeds.join(','))
  await prisma.$connect()

  for (const feed of feeds) {
    const results = await pollV2exFeed(feed, {
      maxItems: config.v2exForum.maxItemsPerFeed,
      timeoutMs: config.v2exForum.timeoutMs,
      userAgent: config.v2exForum.userAgent,
      interestKeywords: config.v2exForum.interestKeywords,
      fetchDetails: config.v2exForum.fetchDetails,
      detailReplyLimit: config.v2exForum.detailReplyLimit,
    })
    console.log(`V2EX feed ${JSON.stringify(feed)} read ${results.length} item(s)`)
  }
}

main()
  .catch((err) => {
    console.error('V2EX forum poll failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
