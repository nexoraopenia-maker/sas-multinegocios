import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '@/server/context';
import { withTenant } from '@/server/db';
import { buildSnapshot } from '@/server/domain/queries';
import { computeAlerts } from '@/shared/alerts';
import { variantLabel } from '@/shared/snapshot';
import { DEMO_BUSINESS, seedDemo } from '../scripts/seed-demo';
import { PASSWORD, makeBusiness, makeRegister, must, signIn, stockOf, superAdmin, unique } from './helpers';

describe('cuenta de demostración', () => {
  const email = `demo-${unique()}@tienda.test`;
  let first: Awaited<ReturnType<typeof seedDemo>>;
  let ctx: Ctx;

  beforeAll(async () => {
    await superAdmin();
    first = await seedDemo({ email, password: PASSWORD });
    ctx = (await signIn(email)).ctx!;
  });

  const counts = () => withTenant(first.tenantId, async (tx) => ({
    products: await tx.product.count(), variants: await tx.variant.count(), lots: await tx.lot.count(),
    movements: await tx.stockMovement.count(), categories: await tx.category.count(),
  }));

  it('permite ingresar y exige cambiar la contraseña', async () => {
    expect(ctx.tenantId).toBe(first.tenantId);
    expect((await signIn(email)).mustChangePassword).toBe(true);
    expect((await signIn(email)).tenantName).toBe(DEMO_BUSINESS);
  });

  it('es idempotente: no duplica ni cambia nada al repetirse', async () => {
    const before = await counts();
    const again = await seedDemo({ email, password: 'Otra-clave-distinta-9' });
    expect(again).toMatchObject({ tenantId: first.tenantId, created: 0, newPassword: null });
    expect(await counts()).toEqual(before);
    await expect(signIn(email, PASSWORD)).resolves.toBeTruthy();
  });

  it('deja datos para probar las tres alertas', async () => {
    const snapshot = await buildSnapshot(ctx, first.branchId, randomUUID());
    const alerts = computeAlerts({
      variants: snapshot.variants.map((v) => {
        const p = snapshot.products.find((x) => x.id === v.productId)!;
        return { id: v.id, label: variantLabel(p, v), sku: v.sku, minStock: v.minStock, tracksExpiry: p.tracksExpiry, active: true };
      }),
      balances: snapshot.balances, lots: snapshot.lots, branchIds: [first.branchId],
      switches: { expired: true, expiring: true, lowStock: true, daysAhead: 30 },
    });
    expect(alerts.expired.map((a) => a.sku)).toEqual(['DEMO-GAL-200']);
    expect(alerts.expiring.map((a) => a.sku)).toEqual(['DEMO-CHO-100']);
    expect(alerts.lowStock.map((a) => a.sku).sort()).toEqual(['DEMO-AGU-625', 'DEMO-CAS-M', 'DEMO-ZAP-42']);
  });

  it('permite vender y descuenta el stock', async () => {
    const variant = await withTenant(first.tenantId, (tx) => tx.variant.findFirstOrThrow({ where: { sku: 'DEMO-POL-M' } }));
    const register = await makeRegister(ctx, first.branchId);
    await must(ctx, register.deviceKey, 'sale.create', register.sale(variant.id, 2, 35));
    expect(await stockOf(first.tenantId, first.branchId, variant.id)).toBe(18);
  });

  it('no toca una cuenta que no sea la demo', async () => {
    const other = await makeBusiness();
    await expect(seedDemo({ email: other.email })).rejects.toThrow(/No se modificó nada/);
    expect(await withTenant(other.tenantId, (tx) => tx.product.count())).toBe(0);
  });
});
