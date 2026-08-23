import { parseBoolean, parseStrictPositiveInteger, requireEnv, type EnvSource } from './env.js'
import { parseLoopbackHttpOrigin } from './loopback-origin.js'

export function parseServiceConfig(env: EnvSource) {
  const serviceUrl = (name: string, fallback: string): string => parseLoopbackHttpOrigin(
    name,
    env[name]?.trim() || fallback,
    { requirePort: true },
  )
  const feishu = parseBoolean(env.BOT_FEISHU_ENABLED, false)
    ? {
        appId: requireEnv(env, 'BOT_FEISHU_APP_ID').trim(),
        appSecret: requireEnv(env, 'BOT_FEISHU_APP_SECRET').trim(),
        groupIds: (env.BOT_FEISHU_GROUP_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean),
        ...(env.BOT_OWNER_FEISHU_OPEN_ID?.trim() ? { ownerOpenId: env.BOT_OWNER_FEISHU_OPEN_ID.trim() } : {}),
        gatewayUrl: serviceUrl('BOT_FEISHU_GATEWAY_URL', 'http://127.0.0.1:37927'),
      }
    : undefined
  return {
    feishu,
    browser: {
      enabled: parseBoolean(env.BOT_BROWSER_ENABLED, false),
      controllerUrl: serviceUrl('BOT_BROWSER_CONTROLLER_URL', 'http://127.0.0.1:37921'),
      profileDir: env.BOT_BROWSER_PROFILE_DIR?.trim() || 'data/browser-profile/luna',
      artifactDir: env.BOT_BROWSER_ARTIFACT_DIR?.trim() || 'data/agent-workspace/browser',
      actionLogPath: env.BOT_BROWSER_ACTION_LOG_PATH?.trim() || 'logs/browser-actions.ndjson',
      actionTimeoutMs: parseStrictPositiveInteger('BOT_BROWSER_ACTION_TIMEOUT_MS', env.BOT_BROWSER_ACTION_TIMEOUT_MS, 15_000),
    },
    services: {
      enabled: parseBoolean(env.BOT_PLATFORM_ENABLED, false),
      qqGatewayUrl: serviceUrl('BOT_QQ_GATEWAY_URL', 'http://127.0.0.1:37922'),
      mediaWorkerUrl: serviceUrl('BOT_MEDIA_WORKER_URL', 'http://127.0.0.1:37923'),
      mailboxPollMs: parseStrictPositiveInteger('BOT_MAILBOX_POLL_MS', env.BOT_MAILBOX_POLL_MS, 1_000),
    },
  } as const
}
