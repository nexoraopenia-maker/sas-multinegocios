import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, changePassword, login } from '@/server/auth';
import { disconnect, withPlatform, withTenant } from '@/server/db';
import { saveBranch, saveUser } from '@/server/domain/admin';
import { saveProduct } from '@/server/domain/catalog';
import { buildSnapshot, listNotices } from '@/server/domain/queries';
import { buildReport } from '@/server/reports/reports';
import { createAccount, deleteAccount, getBackup, resetUserPassword, setAccountStatus, updateFeatures } from '@/server/platform';
import { dispatch } from '@/server/api/http';
import { routes } from '@/server/api/routes';
import { parseFeatures } from '@/shared/features';
import { NextRequest } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { makeBusiness, makeProduct, makeRegister, makeUser, PASSWORD, run, signIn, stockOf, superAdmin, unique, type Business } from './helpers';

describe('autenticación, roles y cuentas', () => {
  let b: Business, variant: string;
  beforeAll(async () => {
    b = await makeBusiness();
    variant = await makeProduct(b);
  });
  afterAll(disconnect);

  it('obliga a cambiar la contraseña inicial y bloquea la API hasta entonces', async () => {
    const root = await superAdmin();
    const email = `nuevo-${unique()}@tienda.test`;
    await createAccount(root, { businessName: 'Nueva', businessType: 'ropa', adminName: 'Paul', email, password: PASSWORD });
    const auth = await signIn(email);
    expect(auth.mustChangePassword).toBe(true);
    const request = () => dispatch(routes, new NextRequest('http://localhost/api/settings', { headers: { cookie: `sid=${auth.token}` } }), ['settings']);
    expect((await request()).status).toBe(403);
    await expect(changePassword(auth.token, auth, PASSWORD, 'corta')).rejects.toThrow('10 caracteres');
    await changePassword(auth.token, auth, PASSWORD, 'Otra-clave-456');
    expect((await request()).status).toBe(200);
    await expect(login(email, PASSWORD, 'x')).rejects.toThrow('incorrectos');
  });

  it('limita los intentos de inicio de sesión, también en paralelo', async () => {
    const email = `fuerza-${unique()}@tienda.test`;
    const results = await Promise.allSettled(Array.from({ length: 9 }, () => login(email, 'mala', `ip-${unique()}`)));
    const messages = results.map((r) => (r.status === 'rejected' ? (r.reason as Error).message : 'ok'));
    expect(messages.filter((m) => m.includes('incorrectos'))).toHaveLength(5);
    expect(messages.filter((m) => m.includes('Demasiados'))).toHaveLength(4);
  });

  it('rechaza peticiones de otro origen y sin sesión', async () => {
    const cross = await dispatch(routes, new NextRequest('http://localhost/api/auth/logout', { method: 'POST', headers: { origin: 'https://malo.example', host: 'localhost' } }), ['auth', 'logout']);
    expect(cross.status).toBe(403);
    const anonymous = await dispatch(routes, new NextRequest('http://localhost/api/sales'), ['sales']);
    expect(anonymous.status).toBe(401);
  });

  it('el vendedor no puede administrar, ver costos, reportes ni anular', async () => {
    const seller = await makeUser(b.admin, 'SELLER', [b.main]);
    const ctx = seller.ctx!;
    await expect(saveBranch(ctx, { code: 'T09', name: 'x', address: '', active: true })).rejects.toThrow('permiso');
    await expect(saveUser(ctx, { name: 'x', email: 'z@z.test', role: 'ADMIN', branchIds: [], extraPermissions: [], active: true, password: PASSWORD })).rejects.toThrow('permiso');
    await expect(saveProduct(ctx, { categoryId: b.clothes, name: 'x', brand: '', description: '', tracksExpiry: false, attributes: {}, active: true, variants: [] as never })).rejects.toThrow('permiso');
    await expect(buildReport(ctx, 'valuation', {})).rejects.toThrow('permiso');
    await expect(listNotices(ctx)).rejects.toThrow('permiso');
    const register = await makeRegister(ctx, b.main);
    const snapshot = await buildSnapshot(ctx, b.main, register.deviceKey);
    expect(snapshot.variants.find((v) => v.id === variant)?.cost).toBeNull();
    const sale = register.sale(variant);
    expect((await run(ctx, register.deviceKey, 'sale.create', sale)).status).toBe('APPLIED');
    expect((await run(ctx, register.deviceKey, 'sale.void', { saleId: sale.saleId, reason: 'error' })).error).toContain('permiso');
    expect((await run(ctx, register.deviceKey, 'stock.in', { branchId: b.main, items: [{ variantId: variant, quantity: 1 }] })).status).toBe('REJECTED');
  });

  it('el vendedor no puede rebajar precios ni exceder su descuento', async () => {
    const seller = (await makeUser(b.admin, 'SELLER', [b.main])).ctx!;
    const register = await makeRegister(seller, b.main);
    const cheap = await run(seller, register.deviceKey, 'sale.create', register.sale(variant, 1, 1));
    expect(cheap.error).toContain('Precio no autorizado');
    const big = register.sale(variant, 1, 50);
    big.items[0].discount = 20;
    big.payments[0].amount = 30;
    expect((await run(seller, register.deviceKey, 'sale.create', big)).error).toContain('Descuento');
    const unpaid = register.sale(variant, 1, 50);
    unpaid.payments[0].amount = 1;
    expect((await run(seller, register.deviceKey, 'sale.create', unpaid)).error).toContain('no coinciden');
  });

  it('un usuario solo opera en sus sucursales, aunque consulte el stock de las demás', async () => {
    const seller = (await makeUser(b.admin, 'SELLER', [b.second])).ctx!;
    const register = await makeRegister(seller, b.second);
    const snapshot = await buildSnapshot(seller, b.second, register.deviceKey);
    expect(snapshot.balances.some((x) => x.branchId === b.main && x.variantId === variant)).toBe(true);
    await expect(buildSnapshot(seller, b.main, register.deviceKey)).rejects.toThrow('sucursal');
    const before = await stockOf(b.tenantId, b.main, variant);
    const foreign = await run(seller, register.deviceKey, 'sale.create', { ...register.sale(variant), branchId: b.main });
    expect(foreign.status).toBe('REJECTED');
    expect(await stockOf(b.tenantId, b.main, variant)).toBe(before);
  });

  it('suspender corta las sesiones; reactivar permite volver; eliminar respalda antes', async () => {
    const other = await makeBusiness();
    await makeProduct(other);
    await setAccountStatus(other.root, other.tenantId, 'SUSPENDED');
    await expect(authenticate(other.adminAuth.token)).rejects.toThrow();
    await expect(login(other.email, PASSWORD, 'y')).rejects.toThrow('suspendida');
    await setAccountStatus(other.root, other.tenantId, 'ACTIVE');
    const again = await signIn(other.email);
    await expect(deleteAccount(other.root, other.tenantId, 'nombre incorrecto')).rejects.toThrow('nombre');
    const name = again.tenantName;
    const backup = await deleteAccount(other.root, other.tenantId, name);
    const data = JSON.parse(gunzipSync((await getBackup(other.root, backup.id)).data).toString());
    expect(data.tables.variant).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain('passwordHash');
    await expect(authenticate(again.token)).rejects.toThrow();
    // Eliminación lógica: los datos siguen existiendo.
    expect(await withTenant(other.tenantId, (tx) => tx.variant.count())).toBe(1);
    const log = await withPlatform((tx) => tx.auditLog.findMany({ where: { tenantId: other.tenantId } }));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(['account.create', 'account.suspend', 'account.reactivate', 'account.backup', 'account.delete']));
  });

  it('solo el SuperAdmin usa las funciones de plataforma', async () => {
    await expect(updateFeatures(b.adminAuth, b.tenantId, parseFeatures({ aiAgent: true }))).rejects.toThrow('permiso');
    await expect(resetUserPassword(b.adminAuth, b.admin.userId, PASSWORD)).rejects.toThrow('permiso');
  });
});
