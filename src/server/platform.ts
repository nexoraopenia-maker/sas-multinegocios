/** Operaciones del SuperAdmin (dueño del SaaS). Todas quedan en auditoría. */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { BUSINESS_TYPES, categoryTemplates, type BusinessType } from '@/shared/attributes';
import { featuresSchema, parseFeatures, type Features } from '@/shared/features';
import { DEFAULT_LABEL } from '@/shared/snapshot';
import { audit } from './audit';
import type { AuthInfo } from './auth';
import { lock, withPlatform, withTenant } from './db';
import { AppError, conflict, forbidden, isUniqueViolation, notFound } from './errors';
import { assertPasswordPolicy, hashPassword } from './password';

export function assertSuper(actor: AuthInfo) {
  if (actor.role !== 'SUPERADMIN') throw forbidden();
  if (actor.mustChangePassword) throw new AppError('Cambia tu contraseña antes de continuar', 403, 'PASSWORD_CHANGE_REQUIRED');
}
const by = (a: AuthInfo, tenantId?: string) => ({ tenantId: tenantId ?? null, userId: a.userId, email: a.email });

export const accountInput = z.object({
  businessName: z.string().trim().min(2).max(100),
  businessType: z.enum(Object.keys(BUSINESS_TYPES) as [BusinessType, ...BusinessType[]]),
  adminName: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string(),
});

export async function createAccount(actor: AuthInfo, input: z.infer<typeof accountInput>) {
  assertSuper(actor);
  assertPasswordPolicy(input.password);
  const passwordHash = await hashPassword(input.password);
  const tenantId = randomUUID();
  try {
    // Todo o nada. Es el único punto donde plataforma y negocio comparten transacción: se fija el
    // contexto del negocio recién creado para insertar sus datos iniciales bajo RLS.
    await withPlatform(async (tx) => {
      await tx.tenant.create({ data: { id: tenantId, name: input.businessName, businessType: input.businessType, features: featuresSchema.parse({}) } });
      await tx.user.create({ data: { tenantId, email: input.email, name: input.adminName, passwordHash, role: 'ADMIN' } });
      await audit(tx, by(actor, tenantId), 'account.create', 'Tenant', tenantId, { name: input.businessName, email: input.email });
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.tenantSettings.create({ data: { tenantId, legalName: input.businessName, labelFormat: { ...DEFAULT_LABEL } } });
      await tx.branch.create({ data: { tenantId, code: 'T01', name: 'Principal' } });
      await tx.category.createMany({ data: categoryTemplates(input.businessType).map((c) => ({ tenantId, ...c })) });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Ese correo ya está registrado');
    throw e;
  }
  return { tenantId };
}

async function findTenant(id: string) {
  const t = await withPlatform((tx) => tx.tenant.findUnique({ where: { id } }));
  if (!t) throw notFound('Cuenta');
  return t;
}

export async function setAccountStatus(actor: AuthInfo, tenantId: string, status: 'ACTIVE' | 'SUSPENDED') {
  assertSuper(actor);
  const t = await findTenant(tenantId);
  if (t.status === 'DELETED') throw conflict('La cuenta fue eliminada');
  await withPlatform(async (tx) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { status, suspendedAt: status === 'SUSPENDED' ? new Date() : null } });
    if (status === 'SUSPENDED') await tx.session.deleteMany({ where: { tenantId } });
    await audit(tx, by(actor, tenantId), status === 'SUSPENDED' ? 'account.suspend' : 'account.reactivate', 'Tenant', tenantId);
  });
}

const BACKUP_MODELS = [
  'tenantSettings', 'counter', 'branch', 'userBranch', 'category', 'product', 'variant', 'priceHistory', 'lot', 'stockMovement', 'stockBalance',
  'customer', 'device', 'syncOperation', 'cashSession', 'cashMovement', 'sale', 'saleItem', 'payment', 'saleReturn', 'voucher', 'transfer',
  'transferItem', 'adjustment', 'purchaseDocument', 'purchaseScan', 'supervisorNotice', 'electronicDocument',
] as const;

/** Respaldo completo del negocio (sin contraseñas ni secretos de SUNAT), comprimido y guardado en la plataforma. */
export async function createBackup(actor: AuthInfo, tenantId: string) {
  assertSuper(actor);
  const tenant = await findTenant(tenantId);
  const users = await withPlatform((tx) => tx.user.findMany({ where: { tenantId }, select: { id: true, email: true, name: true, role: true, active: true, extraPermissions: true, createdAt: true } }));
  const tables = await withTenant(tenantId, async (tx) => {
    const out: Record<string, unknown[]> = {};
    for (const model of BACKUP_MODELS) {
      const delegate = tx[model] as unknown as { findMany(a: object): Promise<unknown[]> };
      out[model] = await delegate.findMany({ where: { tenantId } });
    }
    out.auditLog = await tx.auditLog.findMany({ where: { tenantId } });
    out.aiUsage = await tx.aiUsage.findMany({ where: { tenantId } });
    return out;
  }, { timeout: 120_000 });
  // Los archivos adjuntos se guardan en base64.
  tables.purchaseScan = (tables.purchaseScan as { data: Uint8Array }[]).map((r) => ({ ...r, data: Buffer.from(r.data).toString('base64') }));
  const json = JSON.stringify({ version: 1, createdAt: new Date().toISOString(), tenant, users, tables }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return withPlatform(async (tx) => {
    const backup = await tx.tenantBackup.create({ data: { tenantId, createdBy: actor.userId, data: new Uint8Array(gzipSync(json)) } });
    await audit(tx, by(actor, tenantId), 'account.backup', 'TenantBackup', backup.id);
    return { id: backup.id };
  }, { timeout: 60_000 });
}

export async function getBackup(actor: AuthInfo, id: string) {
  assertSuper(actor);
  return withPlatform(async (tx) => {
    const backup = await tx.tenantBackup.findUnique({ where: { id } });
    if (!backup) throw notFound('Respaldo');
    await audit(tx, by(actor, backup.tenantId), 'account.backup.download', 'TenantBackup', id);
    return backup;
  });
}

/** Eliminación lógica, siempre con respaldo previo y confirmación escribiendo el nombre. */
export async function deleteAccount(actor: AuthInfo, tenantId: string, confirmation: string) {
  assertSuper(actor);
  const t = await findTenant(tenantId);
  if (t.status === 'DELETED') throw conflict('La cuenta ya fue eliminada');
  if (confirmation.trim() !== t.name) throw new AppError('Escribe exactamente el nombre del negocio para confirmar');
  const backup = await createBackup(actor, tenantId);
  await withPlatform(async (tx) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { status: 'DELETED', deletedAt: new Date() } });
    await tx.session.deleteMany({ where: { tenantId } });
    await audit(tx, by(actor, tenantId), 'account.delete', 'Tenant', tenantId, { backupId: backup.id });
  });
  return backup;
}

export async function updateFeatures(actor: AuthInfo, tenantId: string, input: Features) {
  assertSuper(actor);
  const features = featuresSchema.parse(input);
  const before = parseFeatures((await findTenant(tenantId)).features);
  await withPlatform(async (tx) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { features } });
    const changes = Object.fromEntries(Object.entries(features).filter(([k, v]) => before[k as keyof Features] !== v));
    await audit(tx, by(actor, tenantId), 'account.features', 'Tenant', tenantId, changes);
  });
}

export async function resetAiUsage(actor: AuthInfo, tenantId: string) {
  assertSuper(actor);
  await withPlatform(async (tx) => {
    await lock(tx, `ai:${tenantId}`);
    await tx.tenant.update({ where: { id: tenantId }, data: { aiUsageResetAt: new Date() } });
    await audit(tx, by(actor, tenantId), 'account.ai.reset', 'Tenant', tenantId);
  });
}

export async function resetUserPassword(actor: AuthInfo, userId: string, password: string) {
  assertSuper(actor);
  assertPasswordPolicy(password);
  const passwordHash = await hashPassword(password);
  await withPlatform(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.role === 'SUPERADMIN') throw notFound('Usuario');
    await tx.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: true, active: true } });
    await tx.session.deleteMany({ where: { userId } });
    await audit(tx, by(actor, user.tenantId ?? undefined), 'user.password.reset', 'User', userId, { email: user.email });
  });
}

export async function saveModelPrice(actor: AuthInfo, input: { model: string; inputPerMTok: number; outputPerMTok: number }) {
  assertSuper(actor);
  const data = z.object({ model: z.string().trim().regex(/^[a-z0-9.-]{3,60}$/), inputPerMTok: z.number().positive().max(10_000), outputPerMTok: z.number().positive().max(10_000) }).parse(input);
  await withPlatform(async (tx) => {
    await tx.aiModelPrice.upsert({ where: { model: data.model }, create: data, update: data });
    await audit(tx, by(actor), 'ai.price', 'AiModelPrice', data.model, data);
  });
}

export async function listAccounts(actor: AuthInfo) {
  assertSuper(actor);
  const { tenants, users } = await withPlatform(async (tx) => ({
    tenants: await tx.tenant.findMany({ orderBy: { createdAt: 'desc' } }),
    users: await tx.user.findMany({ where: { tenantId: { not: null } }, select: { tenantId: true, email: true, role: true, active: true } }),
  }));
  const out = [];
  for (const t of tenants) {
    // La actividad vive en tablas de negocio: se consulta negocio por negocio, dentro de su aislamiento.
    const activity = await withTenant(t.id, async (tx) => {
      const since = new Date(Date.now() - 30 * 86400_000);
      const devices = await tx.device.findMany({ where: { tenantId: t.id } });
      return {
        sales30: await tx.sale.count({ where: { tenantId: t.id, occurredAt: { gte: since }, status: 'COMPLETED' } }),
        rejected30: await tx.syncOperation.count({ where: { tenantId: t.id, status: 'REJECTED', createdAt: { gte: since } } }),
        devices: devices.length,
        pending: devices.reduce((s, d) => s + d.pendingCount, 0),
        lastSync: devices.map((d) => d.lastSyncAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0),
        ai: (await tx.aiUsage.aggregate({ where: { tenantId: t.id, createdAt: { gte: t.aiUsageResetAt } }, _sum: { costUsd: true, inputTokens: true, outputTokens: true } }))._sum,
      };
    });
    const { ai, ...usage } = activity;
    out.push({
      id: t.id, name: t.name, businessType: t.businessType, status: t.status, createdAt: t.createdAt, features: parseFeatures(t.features),
      adminEmail: users.find((u) => u.tenantId === t.id && u.role === 'ADMIN')?.email ?? '',
      users: users.filter((u) => u.tenantId === t.id && u.active).length,
      aiUsd: Number(ai.costUsd ?? 0), aiTokens: (ai.inputTokens ?? 0) + (ai.outputTokens ?? 0),
      ...usage,
    });
  }
  return out;
}

export async function accountDetail(actor: AuthInfo, tenantId: string) {
  assertSuper(actor);
  const account = (await listAccounts(actor)).find((a) => a.id === tenantId);
  if (!account) throw notFound('Cuenta');
  return withPlatform(async (tx) => ({
    account,
    users: await tx.user.findMany({ where: { tenantId }, select: { id: true, name: true, email: true, role: true, active: true, mustChangePassword: true }, orderBy: { name: 'asc' } }),
    backups: await tx.tenantBackup.findMany({ where: { tenantId }, select: { id: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
    usage: await tx.aiUsage.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 25 }),
  }));
}

export async function auditEntries(actor: AuthInfo, take = 200) {
  assertSuper(actor);
  return withPlatform((tx) => tx.auditLog.findMany({ orderBy: { id: 'desc' }, take }));
}

export async function modelPrices(actor: AuthInfo) {
  assertSuper(actor);
  return withPlatform((tx) => tx.aiModelPrice.findMany({ orderBy: { model: 'asc' } }));
}
