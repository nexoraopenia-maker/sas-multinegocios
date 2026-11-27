import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

for (const file of ['.env.local', '.env']) if (existsSync(file)) process.loadEnvFile(file);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Las migraciones usan el rol propietario (DIRECT_URL). La app usa DATABASE_URL con un rol sujeto a RLS.
  datasource: { url: process.env.DIRECT_URL ?? 'postgresql://sin-configurar@localhost:5432/sin-configurar' },
});
