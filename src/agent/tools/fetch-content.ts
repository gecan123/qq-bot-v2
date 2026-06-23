import { z } from 'zod'
import type { Tool } from '../tool.js'
import { createFetchUrlTool } from './fetch-url.js'
import { createFetchImageTool } from './fetch-image.js'
import { createRedditTool } from './reddit.js'

const ALLOWED_SUBREDDITS = ['technology', 'ClaudeAI', 'OpenAI', 'wallstreetbets', 'memes'] as const
const ALLOWED_SET = new Set<string>(ALLOWED_SUBREDDITS)
const REDDIT_POST_REGEX =
  /^https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+(?:\/[^?#]*)?\/?(?:[?#].*)?$/

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('url').describe('抓取普通网页或文本 URL, 返回中文摘要.'),
    url: z.string().url().describe('要抓取的 URL (非 reddit 页面; reddit 帖子请用 action=reddit_post).'),
    hint: z.string().max(200).optional().describe('给摘要 LLM 的侧重提示.'),
  }),
  z.object({
    action: z.literal('image_url').describe('从图片 URL 下载图片.'),
    url: z.string().url().describe('图片 URL (jpg/png/gif/webp).'),
  }),
  z.object({
    action: z.literal('qq_avatar').describe('通过 QQ 号获取用户头像图片.'),
    qq: z.number().int().positive().describe('目标用户的 QQ 号.'),
    size: z.enum(['640', '100', '40']).default('640').describe('头像尺寸: 640(大图), 100(中图), 40(小图).'),
  }),
  z.object({
    action: z.literal('reddit_list').describe('刷 subreddit 帖子摘要.'),
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
  }),
  z.object({
    action: z.literal('reddit_post').describe('深读 reddit 单帖的标题、图片链接和 top 评论.'),
    url: z
      .string()
      .url()
      .refine((u) => REDDIT_POST_REGEX.test(u), {
        message: 'url 必须是 reddit 帖子页 (形如 https://www.reddit.com/r/X/comments/POSTID/...)',
      })
      .describe('reddit 帖子链接, 形如 https://www.reddit.com/r/X/comments/POSTID/...'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface FetchContentDeps {
  urlTool?: Tool
  imageTool?: Tool
  redditTool?: Tool
}

export function createFetchContentTool(deps: FetchContentDeps = {}): Tool<Args> {
  const urlTool = deps.urlTool ?? createFetchUrlTool()
  const imageTool = deps.imageTool ?? createFetchImageTool()
  const redditTool = deps.redditTool ?? createRedditTool()

  return {
    name: 'fetch_content',
    description: [
      '获取外部内容, 一个入口用 action 决定抓取类型.',
      'action=url: 抓普通网页或文本并返回中文摘要; reddit 帖子请用 action=reddit_post.',
      'action=image_url: 下载图片 URL, 返回 ephemeralRef, 可用于 send_message / generate_image / collect_sticker.',
      'action=qq_avatar: 通过 QQ 号获取用户头像, 返回 ephemeralRef 和图片预览.',
      'action=reddit_list: 刷 subreddit 帖子, 返回标题/链接/图片直链/短摘要; subreddit 只能用 technology / ClaudeAI / OpenAI / wallstreetbets / memes.',
      'action=reddit_post: 深读 reddit 单帖链接, 返回标题、图片链接和 top 评论; 图片直链可继续用 action=image_url 下载.',
      '网页和图片结果形态不同, 不要让工具自动猜; 按意图显式选择 action.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = argsSchema.parse(rawArgs)
      if (args.action === 'url') {
        const nextArgs = args.hint === undefined ? { url: args.url } : { url: args.url, hint: args.hint }
        return urlTool.execute(nextArgs, ctx)
      }

      if (args.action === 'image_url') {
        return imageTool.execute({ action: 'url', url: args.url }, ctx)
      }

      if (args.action === 'qq_avatar') {
        return imageTool.execute({ action: 'qq_avatar', qq: args.qq, size: args.size }, ctx)
      }

      if (args.action === 'reddit_list') {
        return redditTool.execute({
          action: 'list',
          subreddit: args.subreddit,
          sort: args.sort,
          limit: args.limit,
        }, ctx)
      }

      return redditTool.execute({ action: 'get_post', url: args.url }, ctx)
    },
  }
}

export const fetchContentTool = createFetchContentTool()
