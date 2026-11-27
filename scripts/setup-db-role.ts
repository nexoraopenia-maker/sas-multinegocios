/** Habilita el inicio de sesión del rol de aplicación "saas_app" con la contraseña indicada en DATABASE_URL. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export async function setupAppRole(directUrl: string, appUrl: string) {
  const url = new URL(appUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (user !== 'saas_app') throw new Error('DATABASE_URL debe usar el usuario "saas_app"');
  if (password.length < 8) throw new Error('Define una contraseña de al menos 8 caracteres en DATABASE_URL');
  const client = new pg.Client({ connectionString: directUrl });
  await client.connect();
  try {
    await client.query(`ALTER ROLE saas_app WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`);
    const { rows } = await client.query<{ bypass: boolean }>("SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = 'saas_app'");
    if (rows[0].bypass) throw new Error('El rol saas_app puede omitir RLS: corrígelo antes de continuar');
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f);
  const { DIRECT_URL, DATABASE_URL } = process.env;
  if (!DIRECT_URL || !DATABASE_URL) throw new Error('Faltan DIRECT_URL y DATABASE_URL (ver .env.example)');
  await setupAppRole(DIRECT_URL, DATABASE_URL);
  console.log('Rol saas_app listo.');
}
