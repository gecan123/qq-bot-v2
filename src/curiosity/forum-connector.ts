import type { ForumReadInput, ForumReadItemInput, ForumReadResult, ForumReadSourceInput } from './forum-read-executor.js'

export interface ForumFeedConnector {
  source: ForumReadSourceInput
  poll(): Promise<ForumReadItemInput[]>
}

export interface PollForumConnectorOptions {
  now?: Date
  selectionReason?: string
  readForumItem?: (input: ForumReadInput) => Promise<ForumReadResult>
}

export class StaticForumFeedConnector implements ForumFeedConnector {
  constructor(
    readonly source: ForumReadSourceInput,
    private readonly items: ForumReadItemInput[],
  ) {}

  async poll(): Promise<ForumReadItemInput[]> {
    return this.items
  }
}

async function defaultReadForumItem(input: ForumReadInput): Promise<ForumReadResult> {
  const { ingestAndReadForumItem } = await import('./forum-read-executor.js')
  return ingestAndReadForumItem(input)
}

export async function pollForumConnector(
  connector: ForumFeedConnector,
  options: PollForumConnectorOptions = {},
): Promise<ForumReadResult[]> {
  const readForumItem = options.readForumItem ?? defaultReadForumItem
  const now = options.now ?? new Date()
  const items = await connector.poll()
  const selectionReason = options.selectionReason ?? `read-only poll from ${connector.source.kind}:${connector.source.externalId}`

  const results: ForumReadResult[] = []
  for (const item of items) {
    results.push(await readForumItem({
      source: connector.source,
      item,
      selectionReason,
      now,
    }))
  }
  return results
}
