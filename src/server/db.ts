import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@/generated/prisma/client';

export type Tx = Prisma.TransactionClient;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; rlsChecked?: Promise<void> };

function client(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('Falta la variable de entorno DATABASE_URL (ver .env.example)');
    globalForPrisma.prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 5 }) });
  }
  return globalForPrisma.prisma;
}

/** Se niega a operar si el rol de conexión puede saltarse RLS (p. ej. el propietario de Neon). */
function assertRlsEnforced(): Promise<void> {
  globalForPrisma.rlsChecked ??= client()
    .$queryRaw<{ bypass: boolean }[]>`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`
    .then((rows) => {
      if (rows[0]?.bypass) throw new Error('DATABASE_URL usa un rol que omite RLS. Usa el rol "saas_app" (ver docs/DESPLIEGUE.md).');
    })
    .catch((e) => {
      globalForPrisma.rlsChecked = undefined;
      throw e;
    });
  return globalForPrisma.rlsChecked;
}

interface TxOptions { timeout?: number; readOnly?: boolean }

async function run<T>(setting: 'app.tenant_id' | 'app.platform', value: string, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}) {
  await assertRlsEnforced();
  return client().$transaction(
    async (tx) => {
      if (opts.readOnly) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SELECT set_config(${setting}, ${value}, true)`;
      return fn(tx);
    },
    { timeout: opts.timeout ?? 20_000, maxWait: 10_000 },
  );
}

/** Transacción aislada a un negocio. El tenantId debe venir SIEMPRE de la sesión del servidor. */
export function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, opts?: TxOptions) {
  if (!tenantId) throw new Error('tenantId requerido');
  return run('app.tenant_id', tenantId, fn, opts);
}

/** Contexto de plataforma: solo autenticación y SuperAdmin. No da acceso a tablas de negocio. */
export function withPlatform<T>(fn: (tx: Tx) => Promise<T>, opts?: TxOptions) {
  return run('app.platform', 'on', fn, opts);
}

/** Bloqueo asesor hasta el fin de la transacción, para serializar operaciones concurrentes. */
export async function lock(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

export async function disconnect() {
  await globalForPrisma.prisma?.$disconnect();
  globalForPrisma.prisma = undefined;
  globalForPrisma.rlsChecked = undefined;
}
