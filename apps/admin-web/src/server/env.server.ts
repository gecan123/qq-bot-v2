import '@tanstack/react-start/server-only'
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.url().refine(
    value => value.startsWith('postgresql://') || value.startsWith('postgres://'),
    'DATABASE_URL must be a PostgreSQL URL',
  ),
}).strict()

export function parseAdminServerEnv(env: NodeJS.ProcessEnv) {
  const result = schema.safeParse({ DATABASE_URL: env.DATABASE_URL })
  if (!result.success) throw new Error('Admin Web server configuration is invalid')
  return result.data
}
