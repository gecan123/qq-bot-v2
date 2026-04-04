import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client";

function createPrisma(): PrismaClient {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
  pool.on("connect", (client) => {
    client.query("SET TIME ZONE 'UTC'");
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
