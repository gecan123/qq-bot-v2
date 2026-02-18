import 'dotenv/config'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export const config = {
  databaseUrl: requireEnv('DATABASE_URL'),
  redisUrl: requireEnv('REDIS_URL'),
  napcat: {
    wsUrl: requireEnv('NAPCAT_WS_URL'),
    accessToken: requireEnv('NAPCAT_ACCESS_TOKEN'),
  },
  groupIds: requireEnv('GROUP_IDS').split(',').map(Number),
  selfNumber: Number(requireEnv('SELF_NUMBER')),
  nodeEnv: process.env.NODE_ENV || 'development',
  replyMediaWaitN: Number(process.env.REPLY_MEDIA_WAIT_N ?? '5'),
  replyMediaTimeoutMs: Number(process.env.REPLY_MEDIA_TIMEOUT_MS ?? '5000'),
} as const
