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
  messageResolutionRefreshWindowMinutes: Number(process.env.MESSAGE_RESOLUTION_REFRESH_WINDOW_MINUTES ?? '30'),
  memoryJobIntervalHours: Number(process.env.MEMORY_JOB_INTERVAL_HOURS ?? '4'),
  memoryJobSkipThreshold: Number(process.env.MEMORY_JOB_SKIP_THRESHOLD ?? '50'),
  jobInterDelayMs: Number(process.env.JOB_INTER_DELAY_MS ?? '200'),
  tavily: process.env.TAVILY_API_KEY
    ? { apiKey: process.env.TAVILY_API_KEY }
    : undefined,
  llm: {
    baseUrl: process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:8317/v1',
    apiKey: process.env.OPENAI_API_KEY ?? 'sk-local',
    model: process.env.OPENAI_MODEL ?? 'gpt-5.1',
    scenarios: {
      describeImage: {
        baseUrl: process.env.LLM_DESCRIBE_IMAGE_BASE_URL,
        apiKey: process.env.LLM_DESCRIBE_IMAGE_API_KEY,
        model: process.env.LLM_DESCRIBE_IMAGE_MODEL,
      },
      describeVideo: {
        baseUrl: process.env.LLM_DESCRIBE_VIDEO_BASE_URL,
        apiKey: process.env.LLM_DESCRIBE_VIDEO_API_KEY,
        model: process.env.LLM_DESCRIBE_VIDEO_MODEL,
      },
      describePdf: {
        baseUrl: process.env.LLM_DESCRIBE_PDF_BASE_URL,
        apiKey: process.env.LLM_DESCRIBE_PDF_API_KEY,
        model: process.env.LLM_DESCRIBE_PDF_MODEL,
      },
      generateText: {
        baseUrl: process.env.LLM_GENERATE_TEXT_BASE_URL,
        apiKey: process.env.LLM_GENERATE_TEXT_API_KEY,
        model: process.env.LLM_GENERATE_TEXT_MODEL,
      },
      generateReply: {
        baseUrl: process.env.LLM_GENERATE_REPLY_BASE_URL,
        apiKey: process.env.LLM_GENERATE_REPLY_API_KEY,
        model: process.env.LLM_GENERATE_REPLY_MODEL,
      },
      transcribeAudio: {
        baseUrl: process.env.LLM_TRANSCRIBE_AUDIO_BASE_URL,
        apiKey: process.env.LLM_TRANSCRIBE_AUDIO_API_KEY,
        model: process.env.LLM_TRANSCRIBE_AUDIO_MODEL,
      },
    },
  },
} as const
