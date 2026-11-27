import { createHash, randomBytes } from 'node:crypto';
import { parseFeatures } from '@/shared/features';
import { permissionsFor, type Role } from '@/shared/permissions';
import type { SessionUser } from '@/shared/snapshot';
import { audit } from './audit';
import type { Ctx } from './context';
import { lock, withPlatform, withTenant } from './db';
import { AppError } from './errors';
import { assertPasswordPolicy, hashPassword, verifyPassword } from './password';

export const SESSION_COOKIE = 'sid';
const BUSINESS_SESSION_MS = 7 * 24 * 3600_000; // permite jornadas sin conexión
const SUPER_SESSION_MS = 8 * 3600_000;
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS_EMAIL = 5;
const MAX_FAILS_IP = 30;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
let dummyHash: Promise<string> | undefined;

export async function login(emailRaw: string, password: string, ip: string) {
  const email = emailRaw.trim().toLowerCase();
  const since = new Date(Date.now() - WINDOW_MS);

  // El intento se anota como fallido ANTES de verificar (con bloqueo), para que las peticiones
  // en paralelo no esquiven el límite. Si el acceso es correcto, esas marcas se eliminan.
  const { user, attemptIds } = await withPlatform(async (tx) => {
    await lock(tx, `login:${email}`);
    await tx.loginAttempt.deleteMany({ where: { key: `email:${email}`, createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } } });
    const lastOk = await tx.loginAttempt.findFirst({ where: { key: `email:${email}`, success: true, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' } });
    const emailFails = await tx.loginAttempt.count({ where: { key: `email:${email}`, success: false, createdAt: { gt: lastOk?.createdAt ?? since } } });
    const ipFails = await tx.loginAttempt.count({ where: { key: `ip:${ip}`, success: false, createdAt: { gte: since } } });
    if (emailFails >= MAX_FAILS_EMAIL || ipFails >= MAX_FAILS_IP) {
      throw new AppError('Demasiados intentos. Espera 15 minutos.', 429, 'RATE_LIMITED');
    }
    const rows = await tx.loginAttempt.createManyAndReturn({ data: [{ key: `email:${email}`, success: false }, { key: `ip:${ip}`, success: false }] });
    return { user: await tx.user.findUnique({ where: { email } }), attemptIds: rows.map((r) => r.id) };
  });

  // Se verifica siempre un hash para no revelar si el correo existe.
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));

  return withPlatform(async (tx) => {
    const tenant = user?.tenantId ? await tx.tenant.findUnique({ where: { id: user.tenantId } }) : null;
    const valid = ok && !!user && user.active;
    if (valid) {
      await tx.loginAttempt.deleteMany({ where: { id: { in: attemptIds } } });
      await tx.loginAttempt.create({ data: { key: `email:${email}`, success: true } });
    }
    if (!valid) return { error: new AppError('Correo o contraseña incorrectos', 401, 'BAD_CREDENTIALS') };
    if (tenant && tenant.status !== 'ACTIVE') {
      return { error: new AppError('La cuenta del negocio está suspendida. Contacta al proveedor.', 403, 'ACCOUNT_SUSPENDED') };
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + (user.role === 'SUPERADMIN' ? SUPER_SESSION_MS : BUSINESS_SESSION_MS));
    await tx.session.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } });
    await tx.session.create({ data: { tokenHash: sha256(token), userId: user.id, tenantId: user.tenantId, expiresAt } });
    return { token, expiresAt, role: user.role as Role, mustChangePassword: user.mustChangePassword };
  }).then((r) => {
    // Se lanza fuera de la transacción para que el intento fallido quede registrado.
    if ('error' in r) throw r.error;
    return r;
  });
}

export interface AuthInfo {
  userId: string; email: string; name: string; role: Role; tenantId: string | null; mustChangePassword: boolean;
  sessionExpiresAt: Date; ctx: Ctx | null; tenantName: string;
}

/** Valida la sesión y el estado de la cuenta en cada petición. */
export async function authenticate(token: string | undefined): Promise<AuthInfo> {
  const unauthorized = new AppError('Inicia sesión para continuar', 401, 'UNAUTHENTICATED');
  if (!token) throw unauthorized;
  const base = await withPlatform(async (tx) => {
    const session = await tx.session.findUnique({ where: { tokenHash: sha256(token) } });
    if (!session || session.expiresAt < new Date()) return null;
    const user = await tx.user.findUnique({ where: { id: session.userId } });
    if (!user || !user.active) return null;
    const tenant = user.tenantId ? await tx.tenant.findUnique({ where: { id: user.tenantId } }) : null;
    return { session, user, tenant };
  });
  if (!base) throw unauthorized;
  const { session, user, tenant } = base;
  const common = {
    userId: user.id, email: user.email, name: user.name, role: user.role as Role, tenantId: user.tenantId,
    mustChangePassword: user.mustChangePassword, sessionExpiresAt: session.expiresAt,
  };
  if (user.role === 'SUPERADMIN') return { ...common, ctx: null, tenantName: '' };
  if (!tenant || tenant.status !== 'ACTIVE') {
    throw new AppError('La cuenta del negocio está suspendida o eliminada', 403, 'ACCOUNT_SUSPENDED');
  }
  const branchIds = await withTenant(tenant.id, async (tx) => {
    const where = { tenantId: tenant.id, active: true };
    if (user.role === 'ADMIN') return (await tx.branch.findMany({ where, select: { id: true }, orderBy: { code: 'asc' } })).map((b) => b.id);
    const links = await tx.userBranch.findMany({ where: { tenantId: tenant.id, userId: user.id, branch: { active: true } }, select: { branchId: true } });
    return links.map((l) => l.branchId);
  });
  const features = parseFeatures(tenant.features);
  const ctx: Ctx = {
    tenantId: tenant.id, userId: user.id, name: user.name, email: user.email, role: user.role as Role,
    permissions: new Set(permissionsFor(user.role as Role, user.extraPermissions)),
    // Sin multisucursal solo opera la primera sede.
    branchIds: features.multiBranch ? branchIds : branchIds.slice(0, 1), features,
  };
  return { ...common, ctx, tenantName: tenant.name };
}

export function toSessionUser(a: AuthInfo): SessionUser {
  const c = a.ctx!;
  return {
    id: a.userId, name: a.name, email: a.email, role: a.role, tenantId: c.tenantId, tenantName: a.tenantName,
    permissions: [...c.permissions], branchIds: c.branchIds, features: c.features,
    mustChangePassword: a.mustChangePassword, sessionExpiresAt: a.sessionExpiresAt.toISOString(),
  };
}

export async function logout(token: string | undefined) {
  if (!token) return;
  await withPlatform((tx) => tx.session.deleteMany({ where: { tokenHash: sha256(token) } }));
}

export async function changePassword(token: string, auth: AuthInfo, current: string, next: string) {
  assertPasswordPolicy(next);
  if (current === next) throw new AppError('La nueva contraseña debe ser distinta de la actual');
  const user = await withPlatform((tx) => tx.user.findUniqueOrThrow({ where: { id: auth.userId } }));
  if (!(await verifyPassword(current, user.passwordHash))) throw new AppError('La contraseña actual no es correcta', 400, 'BAD_CREDENTIALS');
  const passwordHash = await hashPassword(next);
  await withPlatform(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
    // Cierra las demás sesiones abiertas.
    await tx.session.deleteMany({ where: { userId: user.id, tokenHash: { not: sha256(token) } } });
    await audit(tx, { tenantId: user.tenantId, userId: user.id, email: user.email }, 'password.change', 'User', user.id);
  });
}
