/** Crea el primer SuperAdmin a partir de variables de entorno. No hay credenciales por defecto. */
import { existsSync } from 'node:fs';

for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f);

const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SUPERADMIN_PASSWORD;
if (!email || !password) {
  console.error('Define SUPERADMIN_EMAIL y SUPERADMIN_PASSWORD (ver .env.example).');
  process.exit(1);
}

const { withPlatform, disconnect } = await import('../src/server/db');
const { hashPassword, assertPasswordPolicy } = await import('../src/server/password');
const { audit } = await import('../src/server/audit');

assertPasswordPolicy(password);
const passwordHash = await hashPassword(password);
await withPlatform(async (tx) => {
  if (await tx.user.findUnique({ where: { email } })) throw new Error('Ese correo ya existe');
  const user = await tx.user.create({ data: { email, name: 'SuperAdmin', role: 'SUPERADMIN', passwordHash } });
  await audit(tx, { userId: user.id, email }, 'superadmin.create', 'User', user.id);
});
await disconnect();
console.log(`SuperAdmin creado: ${email}. Deberá cambiar la contraseña al ingresar.`);
