import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnect, withPlatform, withTenant } from '@/server/db';
import { buildSnapshot, saleDetail } from '@/server/domain/queries';
import { makeBusiness, makeProduct, makeRegister, must, run, type Business } from './helpers';

describe('aislamiento entre negocios', () => {
  let a: Business, b: Business, variantA: string;
  beforeAll(async () => {
    a = await makeBusiness();
    b = await makeBusiness();
    variantA = await makeProduct(a);
  });
  afterAll(disconnect);

  it('RLS: un negocio no ve filas de otro aunque la consulta no filtre', async () => {
    const seen = await withTenant(b.tenantId, (tx) => tx.variant.findMany());
    expect(seen.map((v) => v.id)).not.toContain(variantA);
    const movements = await withTenant(b.tenantId, (tx) => tx.stockMovement.findMany());
    expect(movements.every((m) => m.tenantId === b.tenantId)).toBe(true);
    const tenants = await withTenant(b.tenantId, (tx) => tx.tenant.findMany());
    expect(tenants.map((t) => t.id)).toEqual([b.tenantId]);
  });

  it('RLS: no permite insertar ni modificar datos de otro negocio', async () => {
    await expect(withTenant(b.tenantId, (tx) => tx.branch.create({ data: { tenantId: a.tenantId, code: 'X1', name: 'Intrusa' } }))).rejects.toThrow();
    const touched = await withTenant(b.tenantId, (tx) => tx.variant.updateMany({ where: { id: variantA }, data: { price: 1 } }));
    expect(touched.count).toBe(0);
  });

  it('las claves compuestas impiden referenciar productos ajenos', async () => {
    await expect(withTenant(b.tenantId, (tx) =>
      tx.variant.create({ data: { tenantId: b.tenantId, productId: 'no-existe', sku: 'x', barcode: 'x', attributes: {}, price: 1 } }))).rejects.toThrow();
  });

  it('el contexto de plataforma no da acceso a tablas de negocio', async () => {
    expect(await withPlatform((tx) => tx.variant.findMany())).toEqual([]);
    expect(await withPlatform((tx) => tx.sale.findMany())).toEqual([]);
  });

  it('un negocio no puede cambiar sus feature flags ni ver usuarios de plataforma', async () => {
    const changed = await withTenant(a.tenantId, (tx) => tx.tenant.updateMany({ where: { id: a.tenantId }, data: { features: { aiAgent: true } } }));
    expect(changed.count).toBe(0);
    const users = await withTenant(a.tenantId, (tx) => tx.user.findMany());
    expect(users.every((u) => u.tenantId === a.tenantId)).toBe(true);
    await expect(withTenant(a.tenantId, (tx) => tx.user.create({ data: { tenantId: a.tenantId, email: 'x@y.test', name: 'x', passwordHash: 'x', role: 'SUPERADMIN' } }))).rejects.toThrow();
  });

  it('el kárdex y la auditoría no se pueden alterar', async () => {
    await expect(withTenant(a.tenantId, (tx) => tx.stockMovement.updateMany({ where: { tenantId: a.tenantId }, data: { quantity: 999 } }))).rejects.toThrow();
    await expect(withTenant(a.tenantId, (tx) => tx.stockMovement.deleteMany({ where: { tenantId: a.tenantId } }))).rejects.toThrow();
    await expect(withPlatform((tx) => tx.auditLog.deleteMany())).rejects.toThrow();
  });

  it('operar sobre productos, ventas o sucursales ajenas se rechaza', async () => {
    const own = await makeRegister(b.admin, b.main);
    const foreign = await run(b.admin, own.deviceKey, 'sale.create', own.sale(variantA));
    expect(foreign.status).toBe('REJECTED');
    const branch = await run(b.admin, own.deviceKey, 'stock.in', { branchId: a.main, items: [{ variantId: variantA, quantity: 5 }] });
    expect(branch.status).toBe('REJECTED');
    const register = await makeRegister(a.admin, a.main);
    const sale = register.sale(variantA);
    await must(a.admin, register.deviceKey, 'sale.create', sale);
    await expect(saleDetail(b.admin, sale.saleId)).rejects.toThrow('no encontrado');
    await expect(buildSnapshot(b.admin, a.main, own.deviceKey)).rejects.toThrow('sucursal');
    const snapshot = await buildSnapshot(b.admin, b.main, own.deviceKey);
    expect(snapshot.variants.map((v) => v.id)).not.toContain(variantA);
  });
});
