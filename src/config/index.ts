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
  memoryJobIntervalHours: Number(process.env.MEMORY_JOB_INTERVAL_HOURS ?? '4'),
  memoryJobSkipThreshold: Number(process.env.MEMORY_JOB_SKIP_THRESHOLD ?? '20'),
  jobInterDelayMs: Number(process.env.JOB_INTER_DELAY_MS ?? '200'),
  llm: {
    provider: (process.env.LLM_PROVIDER ?? 'gemini') as 'gemini' | 'openai',
    openai: {
      baseUrl: process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:8317/v1',
      apiKey: process.env.OPENAI_API_KEY ?? 'sk-local',
      model: process.env.OPENAI_MODEL ?? 'gpt-5.1',
    },
    gemini: {
      model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    },
    scenarios: {
      describeImage: {
        provider: process.env.LLM_DESCRIBE_IMAGE_PROVIDER as 'gemini' | 'openai' | undefined,
        model: process.env.LLM_DESCRIBE_IMAGE_MODEL,
      },
      summarizeText: {
        provider: process.env.LLM_SUMMARIZE_TEXT_PROVIDER as 'gemini' | 'openai' | undefined,
        model: process.env.LLM_SUMMARIZE_TEXT_MODEL,
      },
      generateText: {
        provider: process.env.LLM_GENERATE_TEXT_PROVIDER as 'gemini' | 'openai' | undefined,
        model: process.env.LLM_GENERATE_TEXT_MODEL,
      },
      generateReply: {
        provider: process.env.LLM_GENERATE_REPLY_PROVIDER as 'gemini' | 'openai' | undefined,
        model: process.env.LLM_GENERATE_REPLY_MODEL,
      },
      transcribeAudio: {
        provider: process.env.LLM_TRANSCRIBE_AUDIO_PROVIDER as 'gemini' | 'openai' | undefined,
        model: process.env.LLM_TRANSCRIBE_AUDIO_MODEL,
      },
    },
  },
} as const
