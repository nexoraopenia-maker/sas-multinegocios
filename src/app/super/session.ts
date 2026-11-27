import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { authenticate, SESSION_COOKIE, type AuthInfo } from '@/server/auth';

/** Sesión de SuperAdmin validada en el servidor. Se llama en cada página, acción y descarga. */
export async function requireSuper(): Promise<AuthInfo> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const auth = await authenticate(token).catch(() => null);
  if (!auth) redirect('/login');
  if (auth.role !== 'SUPERADMIN') redirect('/app');
  if (auth.mustChangePassword) redirect('/cambiar-clave');
  return auth;
}
