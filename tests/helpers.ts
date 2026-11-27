import { randomUUID } from 'node:crypto';
import type { Operation, OperationType } from '@/shared/operations';
import { authenticate, login, type AuthInfo } from '@/server/auth';
import type { Ctx } from '@/server/context';
import { withPlatform, withTenant } from '@/server/db';
import { hashPassword } from '@/server/password';
import { saveBranch, saveUser } from '@/server/domain/admin';
import { saveProduct, type ProductInput } from '@/server/domain/catalog';
import { processOperation, registerDevice } from '@/server/domain/sync';
import { createAccount, updateFeatures } from '@/server/platform';
import { parseFeatures, type Features } from '@/shared/features';

export const PASSWORD = 'Clave-segura-123';
let n = 0;
export const unique = () => `${Date.now().toString(36)}${n++}`;

export async function signIn(email: string, password = PASSWORD): Promise<AuthInfo & { token: string }> {
  const { token } = await login(email, password, `ip-${unique()}`);
  return { ...(await authenticate(token)), token };
}

export async function superAdmin() {
  const email = `root-${unique()}@saas.test`;
  const passwordHash = await hashPassword(PASSWORD);
  await withPlatform((tx) => tx.user.create({ data: { email, name: 'Root', role: 'SUPERADMIN', passwordHash, mustChangePassword: false } }));
  return signIn(email);
}

const ready = (userId: string) => withPlatform((tx) => tx.user.update({ where: { id: userId }, data: { mustChangePassword: false } }));

export async function makeUser(admin: Ctx, role: 'SUPERVISOR' | 'SELLER', branchIds: string[], extra: string[] = []) {
  const email = `${role.toLowerCase()}-${unique()}@tienda.test`;
  const { id } = await saveUser(admin, { name: role, email, role, branchIds, extraPermissions: extra, active: true, password: PASSWORD });
  await ready(id);
  return signIn(email);
}

/** Negocio completo: cuenta, dos sucursales, administrador, producto y dispositivo. */
export async function makeBusiness(features: Partial<Features> = {}) {
  const root = await superAdmin();
  const email = `admin-${unique()}@tienda.test`;
  const { tenantId } = await createAccount(root, { businessName: `Tienda ${unique()}`, businessType: 'mixta', adminName: 'Ana', email, password: PASSWORD });
  if (Object.keys(features).length) await updateFeatures(root, tenantId, { ...parseFeatures({}), ...features });
  const user = await withPlatform((tx) => tx.user.findUniqueOrThrow({ where: { email } }));
  await ready(user.id);
  let auth = await signIn(email);
  const second = await saveBranch(auth.ctx!, { code: 'T02', name: 'Centro', address: '', active: true });
  auth = { ...(await authenticate(auth.token)), token: auth.token };
  const admin = auth.ctx!;
  const [main] = admin.branchIds;
  const categories = await withTenant(tenantId, (tx) => tx.category.findMany({ where: { tenantId } }));
  const clothes = categories.find((c) => c.name === 'Ropa')!;
  const food = categories.find((c) => c.name === 'Alimentos y bebidas')!;
  return { root, tenantId, email, admin, main, second: second.id, clothes: clothes.id, food: food.id, adminAuth: auth };
}
export type Business = Awaited<ReturnType<typeof makeBusiness>>;

export async function makeProduct(b: Business, over: Partial<ProductInput> & { stock?: number; price?: number; expiresAt?: string } = {}) {
  const { stock = 10, price = 50, expiresAt, ...rest } = over;
  const saved = await saveProduct(b.admin, {
    categoryId: b.clothes, name: `Polo ${unique()}`, brand: '', description: '', tracksExpiry: false, attributes: {}, active: true, branchId: b.main,
    variants: [{ sku: '', barcode: '', attributes: {}, price, cost: 20, minStock: 2, active: true, initialStock: stock, expiresAt }],
    ...rest,
  });
  return saved.variantIds[0];
}

export const op = (type: OperationType, payload: object, id: string = randomUUID(), clientTime = new Date().toISOString()): Operation => ({ id, type, payload, clientTime });

export const run = (ctx: Ctx, deviceKey: string, type: OperationType, payload: object) => processOperation(ctx, deviceKey, op(type, payload));

/** Aplica y exige éxito. */
export async function must(ctx: Ctx, deviceKey: string, type: OperationType, payload: object) {
  const r = await run(ctx, deviceKey, type, payload);
  if (r.status !== 'APPLIED') throw new Error(r.error);
  return r;
}

export async function makeRegister(ctx: Ctx, branchId: string) {
  const deviceKey = randomUUID();
  const device = await registerDevice(ctx, { deviceKey, branchId, name: 'Caja' });
  const cashSessionId = randomUUID();
  await must(ctx, deviceKey, 'cash.open', { cashSessionId, branchId, openingAmount: 100 });
  let number = 0;
  const sale = (variantId: string, quantity = 1, price = 50, extra: object = {}) => ({
    saleId: randomUUID(), branchId, series: device.series, number: ++number, cashSessionId,
    items: [{ variantId, quantity, unitPrice: price, discount: 0 }], payments: [{ method: 'CASH' as const, amount: quantity * price, reference: '' }], ...extra,
  });
  return { deviceKey, series: device.series, cashSessionId, sale };
}

export const stockOf = (tenantId: string, branchId: string, variantId: string) =>
  withTenant(tenantId, async (tx) => Number((await tx.stockBalance.aggregate({ where: { tenantId, branchId, variantId }, _sum: { quantity: true } }))._sum.quantity ?? 0));
