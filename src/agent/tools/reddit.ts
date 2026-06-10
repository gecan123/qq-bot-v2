import { z } from 'zod'
import type { Tool } from '../tool.js'
import { createListRedditTool } from './reddit/list.js'
import { createGetRedditPostTool } from './reddit/get-post.js'
import type { RedditFetchDeps } from './reddit/shared.js'

const ALLOWED_SUBREDDITS = ['technology', 'ClaudeAI', 'OpenAI', 'wallstreetbets', 'memes'] as const
const ALLOWED_SET = new Set<string>(ALLOWED_SUBREDDITS)
const REDDIT_POST_REGEX =
  /^https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+(?:\/[^?#]*)?\/?(?:[?#].*)?$/

const listArgsSchema = z.object({
  action: z.literal('list').describe('列 subreddit 帖子摘要.'),
  subreddit: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((s): s is (typeof ALLOWED_SUBREDDITS)[number] => ALLOWED_SET.has(s), {
      message: `只允许这些 subreddit: ${ALLOWED_SUBREDDITS.join(', ')}`,
    })
    .describe(`subreddit 名 (可选值: ${ALLOWED_SUBREDDITS.join(' / ')}).`),
  sort: z.enum(['hot', 'top', 'new']).default('hot').describe('排序: hot / top / new. 默认 hot.'),
  limit: z.number().int().min(1).max(10).default(10).describe('返回前 N 条, 上限 10.'),
})

const getPostArgsSchema = z.object({
  action: z.literal('get_post').describe('读取 reddit 单帖的标题、图片链接和 top 评论.'),
  url: z
    .string()
    .url()
    .refine((u) => REDDIT_POST_REGEX.test(u), {
      message: 'url 必须是 reddit 帖子页 (形如 https://www.reddit.com/r/X/comments/POSTID/...)',
    })
    .describe('reddit 帖子链接, 形如 https://www.reddit.com/r/X/comments/POSTID/...'),
})

const argsSchema = z.discriminatedUnion('action', [
  listArgsSchema,
  getPostArgsSchema,
])

type Args = z.infer<typeof argsSchema>

export function createRedditTool(deps: RedditFetchDeps = {}): Tool<Args> {
  const list = createListRedditTool(deps)
  const getPost = createGetRedditPostTool(deps)

  return {
    name: 'reddit',
    description: [
      'Reddit 按需读取工具, 一个入口用 action 决定动作.',
      'action=list: 列 subreddit 帖子, 只返回标题/链接/图片直链/短摘要; subreddit 只能用 technology / ClaudeAI / OpenAI / wallstreetbets / memes.',
      'action=get_post: 深读 list 返回的一条 reddit 帖子链接, 返回标题、图片链接和 top 评论.',
      '不要用 fetch_url 抓 reddit; Reddit 走这个专用工具. 输出有图片直链时可交给 fetch_image action=url.',
    ].join(' '),
    schema: argsSchema,
    async execute(args, ctx) {
      if (args.action === 'list') {
        return await list.execute({
          subreddit: args.subreddit,
          sort: args.sort,
          limit: args.limit,
        }, ctx)
      }
      return await getPost.execute({ url: args.url }, ctx)
    },
  }
}

export const redditTool = createRedditTool()
