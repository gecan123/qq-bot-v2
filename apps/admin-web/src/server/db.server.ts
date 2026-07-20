import '@tanstack/react-start/server-only'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../../../src/generated/prisma/client.js'
import { parseAdminServerEnv } from './env.server.js'

const globalForAdminDb = globalThis as typeof globalThis & {
  __qqBotAdminPrisma?: PrismaClient
}

export function getAdminPrisma(): PrismaClient {
  if (globalForAdminDb.__qqBotAdminPrisma) return globalForAdminDb.__qqBotAdminPrisma
  const { DATABASE_URL } = parseAdminServerEnv(process.env)
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) })
  if (process.env.NODE_ENV !== 'production') globalForAdminDb.__qqBotAdminPrisma = prisma
  return prisma
}
