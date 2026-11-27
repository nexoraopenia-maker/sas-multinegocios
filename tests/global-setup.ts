import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { setupAppRole } from '../scripts/setup-db-role';

/** Recrea el esquema de la base de pruebas y aplica las migraciones reales. */
export default async function setup() {
  for (const f of ['.env.test.local', '.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f);
  const direct = process.env.TEST_DIRECT_URL;
  const app = process.env.TEST_DATABASE_URL;
  if (!direct || !app) throw new Error('Define TEST_DATABASE_URL y TEST_DIRECT_URL (ver .env.example)');
  for (const u of [direct, app]) {
    if (!new URL(u).pathname.includes('test')) throw new Error('Por seguridad, la base de pruebas debe contener "test" en su nombre');
  }
  const client = new pg.Client({ connectionString: direct });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await client.end();
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DIRECT_URL: direct }, stdio: 'pipe' });
  await setupAppRole(direct, app);
}
