import { z } from 'zod';
import { GRANTABLE } from '@/shared/permissions';
import { audit } from '../audit';
import { need, needFeature, type Ctx } from '../context';
import { lock, withTenant } from '../db';
import { AppError, conflict, isUniqueViolation, notFound } from '../errors';
import { assertPasswordPolicy, hashPassword } from '../password';
import { readSettings } from './queries';
import { encryptSecret } from '../sunat/crypto';

export const settingsInput = z.object({
  legalName: z.string().trim().max(150), taxId: z.string().trim().max(15), ticketFooter: z.string().trim().max(200),
  expiryDaysAhead: z.number().int().min(1).max(365),
  alertExpiredEnabled: z.boolean(), alertExpiringEnabled: z.boolean(), alertLowStockEnabled: z.boolean(),
  maxSellerDiscountPct: z.number().min(0).max(100),
  labelFormat: z.object({
    widthMm: z.number().min(20).max(150), heightMm: z.number().min(10).max(150), columns: z.number().int().min(1).max(8),
    symbol: z.enum(['code128', 'ean13', 'qrcode']), showName: z.boolean(), showPrice: z.boolean(), showSku: z.boolean(),
  }),
});

export const getSettings = (ctx: Ctx) => withTenant(ctx.tenantId, (tx) => readSettings(tx, ctx));

export async function saveSettings(ctx: Ctx, input: z.infer<typeof settingsInput>) {
  need(ctx, 'settings.manage');
  return withTenant(ctx.tenantId, async (tx) => {
    await tx.tenantSettings.update({ where: { tenantId: ctx.tenantId }, data: input });
    await audit(tx, ctx, 'settings.update', 'TenantSettings', ctx.tenantId, input);
    return readSettings(tx, ctx);
  });
}

export const branchInput = z.object({
  id: z.string().optional(),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,6}$/, 'Código de 2 a 6 letras o números'),
  name: z.string().trim().min(1).max(80), address: z.string().trim().max(200).default(''), active: z.boolean().default(true),
});

export async function listBranches(ctx: Ctx) {
  need(ctx, 'branches.manage');
  return withTenant(ctx.tenantId, (tx) => tx.branch.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { code: 'asc' } }));
}

export async function saveBranch(ctx: Ctx, input: z.infer<typeof branchInput>) {
  need(ctx, 'branches.manage');
  return withTenant(ctx.tenantId, async (tx) => {
    await lock(tx, `branches:${ctx.tenantId}`);
    const current = input.id ? await tx.branch.findFirst({ where: { tenantId: ctx.tenantId, id: input.id } }) : null;
    if (input.id && !current) throw notFound('Sucursal');
    const activeOthers = await tx.branch.count({ where: { tenantId: ctx.tenantId, active: true, ...(current ? { id: { not: current.id } } : {}) } });
    const limit = ctx.features.multiBranch ? ctx.features.maxBranches : 1;
    if (input.active && !current?.active && activeOthers >= limit) throw new AppError(`Tu cuenta permite ${limit} sucursal(es) activa(s)`, 403, 'LIMIT_REACHED');
    if (!input.active && activeOthers === 0) throw new AppError('Debe quedar al menos una sucursal activa');
    const { id: _id, ...data } = input;
    void _id;
    try {
      // El código forma parte de las series ya emitidas: no se cambia.
      const row = current
        ? await tx.branch.update({ where: { id: current.id }, data: { name: data.name, address: data.address, active: data.active } })
        : await tx.branch.create({ data: { ...data, tenantId: ctx.tenantId } });
      await audit(tx, ctx, current ? 'branch.update' : 'branch.create', 'Branch', row.id, data);
      return row;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Ya existe una sucursal con ese código');
      throw e;
    }
  });
}

export const userInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(120),
  role: z.enum(['ADMIN', 'SUPERVISOR', 'SELLER']),
  branchIds: z.array(z.string()).max(500),
  extraPermissions: z.array(z.enum(GRANTABLE as [string, ...string[]])).default([]),
  active: z.boolean().default(true),
  /** Contraseña temporal: obligatoria al crear; al editar, la restablece. */
  password: z.string().optional(),
});

export async function listUsers(ctx: Ctx) {
  need(ctx, 'users.manage');
  return withTenant(ctx.tenantId, async (tx) => {
    const users = await tx.user.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { name: 'asc' } });
    const links = await tx.userBranch.findMany({ where: { tenantId: ctx.tenantId } });
    return users.map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, extraPermissions: u.extraPermissions,
      mustChangePassword: u.mustChangePassword, branchIds: links.filter((l) => l.userId === u.id).map((l) => l.branchId),
    }));
  });
}

export async function saveUser(ctx: Ctx, input: z.infer<typeof userInput>) {
  need(ctx, 'users.manage');
  if (input.password) assertPasswordPolicy(input.password);
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  return withTenant(ctx.tenantId, async (tx) => {
    await lock(tx, `users:${ctx.tenantId}`);
    const current = input.id ? await tx.user.findFirst({ where: { tenantId: ctx.tenantId, id: input.id } }) : null;
    if (input.id && !current) throw notFound('Usuario');
    if (!current && !passwordHash) throw new AppError('Indica una contraseña temporal');
    if (current?.id === ctx.userId && (!input.active || input.role !== current.role)) throw new AppError('No puedes desactivarte ni cambiar tu propio rol');
    if (input.active && !current?.active) {
      const count = await tx.user.count({ where: { tenantId: ctx.tenantId, active: true } });
      if (count >= ctx.features.maxUsers) throw new AppError(`Tu cuenta permite ${ctx.features.maxUsers} usuarios activos`, 403, 'LIMIT_REACHED');
    }
    const validBranches = await tx.branch.count({ where: { tenantId: ctx.tenantId, id: { in: input.branchIds } } });
    if (validBranches !== new Set(input.branchIds).size) throw notFound('Sucursal');
    if (input.role !== 'ADMIN' && !input.branchIds.length) throw new AppError('Asigna al menos una sucursal');
    const data = {
      name: input.name, email: input.email, role: input.role, active: input.active,
      extraPermissions: input.role === 'SELLER' ? input.extraPermissions : [],
      ...(passwordHash ? { passwordHash, mustChangePassword: true } : {}),
    };
    let userId: string;
    try {
      userId = current
        ? (await tx.user.update({ where: { id: current.id }, data })).id
        : (await tx.user.create({ data: { ...data, passwordHash: passwordHash!, tenantId: ctx.tenantId } })).id;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Ese correo ya está registrado');
      throw e;
    }
    await tx.userBranch.deleteMany({ where: { tenantId: ctx.tenantId, userId } });
    if (input.branchIds.length) {
      await tx.userBranch.createMany({ data: [...new Set(input.branchIds)].map((branchId) => ({ tenantId: ctx.tenantId, userId, branchId })) });
    }
    if (current && (passwordHash || !input.active) && current.id !== ctx.userId) await tx.session.deleteMany({ where: { tenantId: ctx.tenantId, userId } });
    await audit(tx, ctx, current ? 'user.update' : 'user.create', 'User', userId, { email: input.email, role: input.role, active: input.active, passwordReset: !!passwordHash });
    return { id: userId };
  });
}

export const sunatInput = z.object({
  ruc: z.string().regex(/^\d{11}$/, 'RUC de 11 dígitos'), solUser: z.string().min(1).max(30), solPassword: z.string().min(1).max(60),
  certificateBase64: z.string().min(100).max(200_000), certificatePassword: z.string().max(100), environment: z.enum(['BETA', 'PRODUCCION']),
});

export async function getSunat(ctx: Ctx) {
  need(ctx, 'settings.manage');
  needFeature(ctx, 'sunat');
  return withTenant(ctx.tenantId, async (tx) => {
    const c = await tx.sunatConfig.findUnique({ where: { tenantId: ctx.tenantId } });
    const queued = await tx.electronicDocument.count({ where: { tenantId: ctx.tenantId, status: 'QUEUED' } });
    return { configured: !!c, ruc: c?.ruc ?? '', solUser: c?.solUser ?? '', environment: c?.environment ?? 'BETA', queued };
  });
}

export async function saveSunat(ctx: Ctx, input: z.infer<typeof sunatInput>) {
  need(ctx, 'settings.manage');
  needFeature(ctx, 'sunat');
  const data = {
    ruc: input.ruc, solUser: input.solUser, environment: input.environment,
    solPasswordEnc: encryptSecret(input.solPassword), certificateEnc: encryptSecret(input.certificateBase64), certPasswordEnc: encryptSecret(input.certificatePassword),
  };
  await withTenant(ctx.tenantId, async (tx) => {
    await tx.sunatConfig.upsert({ where: { tenantId: ctx.tenantId }, create: { ...data, tenantId: ctx.tenantId }, update: data });
    await audit(tx, ctx, 'sunat.configure', 'SunatConfig', ctx.tenantId, { ruc: input.ruc, environment: input.environment });
  });
  return { ok: true };
}
