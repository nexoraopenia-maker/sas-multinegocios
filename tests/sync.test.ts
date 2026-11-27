import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnect, withTenant } from '@/server/db';
import { saveProduct } from '@/server/domain/catalog';
import { processOperation, registerDevice } from '@/server/domain/sync';
import { makeBusiness, makeProduct, makeRegister, makeUser, op, stockOf, type Business } from './helpers';

describe('sincronización offline', () => {
  let b: Business;
  beforeAll(async () => { b = await makeBusiness(); });
  afterAll(disconnect);

  it('reenviar la misma operación no duplica nada, ni en paralelo', async () => {
    const v = await makeProduct(b, { stock: 10 });
    const register = await makeRegister(b.admin, b.main);
    const operation = op('sale.create', register.sale(v, 2));
    const results = await Promise.all(Array.from({ length: 5 }, () => processOperation(b.admin, register.deviceKey, operation)));
    expect(results.every((r) => r.status === 'APPLIED')).toBe(true);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await stockOf(b.tenantId, b.main, v)).toBe(8);
    expect(await withTenant(b.tenantId, (tx) => tx.payment.count({ where: { saleId: (operation.payload as { saleId: string }).saleId } }))).toBe(1);
  });

  it('la misma clave con otros datos se rechaza', async () => {
    const v = await makeProduct(b, { stock: 10 });
    const register = await makeRegister(b.admin, b.main);
    const first = op('sale.create', register.sale(v, 1));
    await processOperation(b.admin, register.deviceKey, first);
    const r = await processOperation(b.admin, register.deviceKey, { ...first, payload: register.sale(v, 5) });
    expect(r.status).toBe('REJECTED');
    expect(await stockOf(b.tenantId, b.main, v)).toBe(9);
  });

  it('dos dispositivos sin conexión se combinan; el stock negativo alerta al supervisor', async () => {
    const v = await makeProduct(b, { stock: 3 });
    const one = await makeRegister(b.admin, b.main);
    const two = await makeRegister(b.admin, b.main);
    expect(one.series).not.toBe(two.series);
    const earlier = new Date(Date.now() - 3600_000).toISOString();
    const a = await processOperation(b.admin, one.deviceKey, op('sale.create', one.sale(v, 2), randomUUID(), earlier));
    const c = await processOperation(b.admin, two.deviceKey, op('sale.create', two.sale(v, 2)));
    expect([a.status, c.status]).toEqual(['APPLIED', 'APPLIED']);
    expect(await stockOf(b.tenantId, b.main, v)).toBe(-1);
    const notices = await withTenant(b.tenantId, (tx) => tx.supervisorNotice.findMany({ where: { type: 'NEGATIVE_STOCK' } }));
    expect(notices.some((x) => (x.data as { variantId: string }).variantId === v)).toBe(true);
    const sale = await withTenant(b.tenantId, (tx) => tx.sale.findFirstOrThrow({ where: { series: one.series } }));
    expect(sale.occurredAt.toISOString()).toBe(earlier); // conserva la hora real de la venta
  });

  it('una hora futura del dispositivo se corrige', async () => {
    const v = await makeProduct(b);
    const register = await makeRegister(b.admin, b.main);
    const operation = op('sale.create', register.sale(v), randomUUID(), '2099-01-01T00:00:00.000Z');
    await processOperation(b.admin, register.deviceKey, operation);
    const sale = await withTenant(b.tenantId, (tx) => tx.sale.findFirstOrThrow({ where: { series: register.series } }));
    expect(sale.occurredAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('acepta el precio anterior en una venta hecha sin conexión y la marca para revisión', async () => {
    const v = await makeProduct(b, { price: 50 });
    const seller = (await makeUser(b.admin, 'SELLER', [b.main])).ctx!;
    const register = await makeRegister(seller, b.main);
    const product = await withTenant(b.tenantId, (tx) => tx.variant.findFirstOrThrow({ where: { id: v }, include: { product: true } }));
    await saveProduct(b.admin, {
      id: product.productId, categoryId: product.product.categoryId, name: product.product.name, brand: '', description: '', tracksExpiry: false, attributes: {}, active: true,
      variants: [{ id: v, sku: product.sku, barcode: product.barcode, attributes: {}, price: 70, minStock: 2, active: true }],
    });
    const r = await processOperation(seller, register.deviceKey, op('sale.create', register.sale(v, 1, 50)));
    expect(r.status).toBe('APPLIED');
    const notices = await withTenant(b.tenantId, (tx) => tx.supervisorNotice.findMany({ where: { type: 'PRICE_REVIEW' } }));
    expect(notices.length).toBeGreaterThan(0);
  });

  it('el rechazo queda registrado, avisa al supervisor y no deja efectos parciales', async () => {
    const v = await makeProduct(b, { stock: 5 });
    const register = await makeRegister(b.admin, b.main);
    const payload = register.sale(v, 1);
    payload.items.push({ variantId: 'inexistente', quantity: 1, unitPrice: 0, discount: 0 });
    const operation = op('sale.create', payload);
    const first = await processOperation(b.admin, register.deviceKey, operation);
    const second = await processOperation(b.admin, register.deviceKey, operation);
    expect(first.status).toBe('REJECTED');
    expect(second).toMatchObject({ status: 'REJECTED', duplicate: true });
    expect(await stockOf(b.tenantId, b.main, v)).toBe(5);
    expect(await withTenant(b.tenantId, (tx) => tx.supervisorNotice.count({ where: { type: 'SYNC_REJECTED' } }))).toBeGreaterThan(0);
  });

  it('el registro de dispositivo es estable y continúa su numeración', async () => {
    const v = await makeProduct(b);
    const register = await makeRegister(b.admin, b.main);
    await processOperation(b.admin, register.deviceKey, op('sale.create', register.sale(v)));
    const again = await registerDevice(b.admin, { deviceKey: register.deviceKey, branchId: b.main, name: 'x' });
    expect(again).toMatchObject({ series: register.series, lastNumber: 1 });
  });
});
