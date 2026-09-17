import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";

// Prisma 7 requires a driver adapter. One client per process; cached on
// globalThis so Next's dev hot reload does not open a new pool per edit.
const globalForPrisma = globalThis as unknown as { __kiriPrisma?: PrismaClient };

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getEnv().DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.__kiriPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__kiriPrisma = prisma;
}
