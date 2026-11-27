import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate } from '@/server/auth';
import { disconnect } from '@/server/db';
import { dashboard } from '@/server/reports/dashboard';
import { todayISO } from '@/shared/stock';
import { makeBusiness, makeProduct, makeRegister, makeUser, must, type Business } from './helpers';

describe('indicadores del panel principal', () => {
  let a: Business, other: Business;
  beforeAll(async () => {
    a = await makeBusiness();
    other = await makeBusiness();
    const v = await makeProduct(a, { stock: 10, price: 50 }); // costo 20
    await makeProduct(other, { stock: 100, price: 999 });
    const register = await makeRegister(a.admin, a.main);
    await must(a.admin, register.deviceKey, 'sale.create', register.sale(v, 3, 50));
    await must(a.admin, register.deviceKey, 'stock.in', { branchId: a.main, reason: 'Compra F001-1', items: [{ variantId: v, quantity: 5, unitCost: 20 }] });
  });
  afterAll(disconnect);

  it('calcula ventas, margen, valorización, compras y movimientos', async () => {
    const d = await dashboard(a.admin, { days: 7 });
    expect(d.series).toHaveLength(7);
    expect(d.series.at(-1)).toMatchObject({ date: todayISO(), count: 1, net: 150 });
    expect(d.today).toEqual({ count: 1, net: 150 });
    expect(d.period).toEqual({ count: 1, net: 150, average: 150 });
    expect(d.margin).toEqual({ amount: 90, percent: 60 });
    expect(d.valuation).toEqual({ cost: 240, sale: 600, potential: 360 }); // 12 unidades
    expect(d.purchases).toMatchObject({ count: 1, total: 100, recent: [{ reason: 'Compra F001-1', units: 5, total: 100, scanId: null }] });
    expect(d.movements.find((m) => m.type === 'SALE')).toEqual({ type: 'SALE', in: 0, out: 3 });
  });

  it('filtra por sucursal y limita el periodo a los permitidos', async () => {
    const d = await dashboard(a.admin, { branchId: a.second, days: 9999 });
    expect(d.days).toBe(30);
    expect(d.period.count).toBe(0);
    expect(d.valuation).toEqual({ cost: 0, sale: 0, potential: 0 });
  });

  it('exige permiso, respeta la sucursal y no mezcla negocios', async () => {
    const seller = (await makeUser(a.admin, 'SELLER', [a.main])).ctx!;
    await expect(dashboard(seller, {})).rejects.toThrow('permiso');
    const supervisor = (await makeUser(a.admin, 'SUPERVISOR', [a.second])).ctx!;
    await expect(dashboard(supervisor, { branchId: a.main })).rejects.toThrow('sucursal');
    expect((await dashboard(supervisor, {})).period.count).toBe(0);
    await expect(dashboard(other.admin, { branchId: a.main })).rejects.toThrow('sucursal');
    expect((await dashboard((await authenticate(other.adminAuth.token)).ctx!, {})).period.count).toBe(0);
  });

  it('oculta importes de costo sin permiso para verlos', async () => {
    const ctx = { ...a.admin, permissions: new Set([...a.admin.permissions].filter((p) => p !== 'cost.view')) };
    const d = await dashboard(ctx, {});
    expect(d.margin).toBeNull();
    expect(d.valuation).toBeNull();
    expect(d.purchases.total).toBeNull();
    expect(d.purchases.recent.every((p) => p.total === null)).toBe(true);
  });
});
