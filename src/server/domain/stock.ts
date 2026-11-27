import type { MovementType } from '@/generated/prisma/client';
import { round3 } from '@/shared/money';
import { allocateFefo, todayISO, type Allocation } from '@/shared/stock';
import type { Ctx } from '../context';
import type { Tx } from '../db';

export interface MovementInput {
  branchId: string; variantId: string; lotId?: string | null; type: MovementType; quantity: number;
  unitCost?: number; reason?: string; refType?: string; refId?: string; occurredAt: Date;
}

export async function notice(tx: Tx, tenantId: string, type: string, message: string, branchId?: string | null, data?: object) {
  await tx.supervisorNotice.create({ data: { tenantId, type, message, branchId: branchId ?? null, data } });
}

/** Inserta movimientos en el kárdex y avisa al supervisor si algún saldo queda negativo. */
export async function addMovements(tx: Tx, ctx: Ctx, movements: MovementInput[]) {
  const rows = movements.filter((m) => m.quantity !== 0);
  if (!rows.length) return;
  await tx.stockMovement.createMany({
    data: rows.map((m) => ({
      tenantId: ctx.tenantId, branchId: m.branchId, variantId: m.variantId, lotId: m.lotId || null, type: m.type,
      quantity: round3(m.quantity), unitCost: m.unitCost ?? 0, reason: m.reason ?? '', userId: ctx.userId,
      refType: m.refType ?? '', refId: m.refId ?? '', occurredAt: m.occurredAt,
    })),
  });
  const outgoing = new Map(rows.filter((m) => m.quantity < 0).map((m) => [`${m.branchId}|${m.variantId}|${m.lotId ?? ''}`, m]));
  for (const m of outgoing.values()) {
    const balance = await tx.stockBalance.findUnique({
      where: { tenantId_branchId_variantId_lotKey: { tenantId: ctx.tenantId, branchId: m.branchId, variantId: m.variantId, lotKey: m.lotId ?? '' } },
    });
    if (balance && Number(balance.quantity) < 0) {
      const v = await tx.variant.findFirst({ where: { tenantId: ctx.tenantId, id: m.variantId }, include: { product: true } });
      await notice(tx, ctx.tenantId, 'NEGATIVE_STOCK',
        `Stock negativo (${Number(balance.quantity)}) en ${v?.product.name ?? m.variantId} [${v?.sku ?? ''}]`,
        m.branchId, { variantId: m.variantId, lotId: m.lotId ?? null, refType: m.refType, refId: m.refId });
    }
  }
}

/** Reparte una salida entre los lotes disponibles (FEFO). */
export async function allocateOut(tx: Tx, ctx: Ctx, branchId: string, variantId: string, quantity: number): Promise<Allocation[]> {
  const balances = await tx.stockBalance.findMany({ where: { tenantId: ctx.tenantId, branchId, variantId } });
  if (!balances.some((b) => b.lotKey !== '')) return [{ lotId: null, quantity }];
  const lots = await tx.lot.findMany({ where: { tenantId: ctx.tenantId, variantId } });
  const expiry = new Map(lots.map((l) => [l.id, l.expiresAt ? l.expiresAt.toISOString().slice(0, 10) : null]));
  return allocateFefo(
    balances.map((b) => ({ lotId: b.lotKey, expiresAt: expiry.get(b.lotKey) ?? null, quantity: Number(b.quantity) })),
    quantity, todayISO(),
  ).map((a) => ({ lotId: a.lotId || null, quantity: a.quantity }));
}

/** Saldo a una fecha: suma del kárdex hasta ese instante (incluye operaciones sincronizadas después). */
export async function stockAt(tx: Tx, ctx: Ctx, branchId: string, variantId: string, lotId: string | null, at: Date) {
  const sum = await tx.stockMovement.aggregate({
    where: { tenantId: ctx.tenantId, branchId, variantId, ...(lotId ? { lotId } : {}), occurredAt: { lte: at } },
    _sum: { quantity: true },
  });
  return Number(sum._sum.quantity ?? 0);
}

export async function getVariants(tx: Tx, ctx: Ctx, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = await tx.variant.findMany({ where: { tenantId: ctx.tenantId, id: { in: unique } }, include: { product: true } });
  return new Map(rows.map((r) => [r.id, r]));
}

export async function assertLot(tx: Tx, ctx: Ctx, variantId: string, lotId: string) {
  return !!(await tx.lot.findFirst({ where: { tenantId: ctx.tenantId, id: lotId, variantId }, select: { id: true } }));
}
