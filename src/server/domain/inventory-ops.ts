import { round2, round3 } from '@/shared/money';
import { audit } from '../audit';
import { needBranch } from '../context';
import { lock } from '../db';
import { AppError, conflict, isUniqueViolation, notFound } from '../errors';
import { addMovements, allocateOut, assertLot, getVariants, stockAt, type MovementInput } from './stock';
import type { Handler } from './types';

export const stockIn: Handler<'stock.in'> = async (tx, ctx, p, meta) => {
  needBranch(ctx, p.branchId);
  await lock(tx, `branch:${ctx.tenantId}:${p.branchId}`);
  if (p.document) {
    const { supplierRuc, docType, series, number } = p.document;
    if (await tx.purchaseDocument.findFirst({ where: { tenantId: ctx.tenantId, supplierRuc, docType, series, number } })) {
      throw conflict(`El comprobante ${series}-${number} del proveedor ${supplierRuc} ya fue ingresado`);
    }
    try {
      await tx.purchaseDocument.create({ data: { ...p.document, tenantId: ctx.tenantId, branchId: p.branchId, userId: ctx.userId } });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Ese comprobante ya fue ingresado');
      throw e;
    }
  }
  const variants = await getVariants(tx, ctx, p.items.map((i) => i.variantId));
  const movements: MovementInput[] = [];
  for (const item of p.items) {
    const v = variants.get(item.variantId);
    if (!v) throw notFound('Producto');
    let lotId: string | null = null;
    const tracks = v.product.tracksExpiry;
    if (tracks && !item.expiresAt && !item.lotCode) throw new AppError(`${v.product.name} controla vencimiento: indica la fecha`);
    if (item.expiresAt || item.lotCode) {
      const code = item.lotCode || `V-${item.expiresAt}`;
      const existing = await tx.lot.findFirst({ where: { tenantId: ctx.tenantId, variantId: v.id, code } });
      if (existing) {
        const current = existing.expiresAt?.toISOString().slice(0, 10) ?? null;
        if (item.expiresAt && current && current !== item.expiresAt) throw new AppError(`El lote ${code} ya existe con vencimiento ${current}`);
        lotId = existing.id;
      } else {
        if (tracks && !item.expiresAt) throw new AppError(`El lote ${code} es nuevo: indica su fecha de vencimiento`);
        lotId = (await tx.lot.create({ data: { tenantId: ctx.tenantId, variantId: v.id, code, expiresAt: item.expiresAt ? new Date(`${item.expiresAt}T00:00:00Z`) : null } })).id;
      }
    }
    if (item.unitCost != null) {
      // Costo promedio ponderado sobre el stock de todo el negocio.
      const sum = await tx.stockBalance.aggregate({ where: { tenantId: ctx.tenantId, variantId: v.id }, _sum: { quantity: true } });
      const queued = movements.filter((m) => m.variantId === v.id).reduce((s, m) => s + m.quantity, 0);
      const current = Math.max(0, Number(sum._sum.quantity ?? 0) + queued);
      const cost = round2((current * Number(v.cost) + item.quantity * item.unitCost) / (current + item.quantity));
      await tx.variant.update({ where: { id: v.id }, data: { cost } });
      v.cost = cost as unknown as typeof v.cost;
    }
    movements.push({
      branchId: p.branchId, variantId: v.id, lotId, type: p.initial ? 'INITIAL' : 'PURCHASE', quantity: item.quantity,
      unitCost: item.unitCost ?? Number(v.cost), reason: p.reason, refType: 'stock.in', refId: meta.opId, occurredAt: meta.time,
    });
  }
  await addMovements(tx, ctx, movements);
  return { lines: movements.length };
};

export const requestAdjustment: Handler<'adjustment.request'> = async (tx, ctx, p, meta) => {
  needBranch(ctx, p.branchId);
  const variants = await getVariants(tx, ctx, p.items.map((i) => i.variantId));
  for (const item of p.items) {
    if (!variants.has(item.variantId)) throw notFound('Producto');
    if (item.lotId && !(await assertLot(tx, ctx, item.variantId, item.lotId))) throw notFound('Lote');
    if (p.kind === 'WASTE' && item.delta >= 0) throw new AppError('Una merma debe ser una salida');
    if (p.kind === 'COUNT' && item.countedQty == null) throw new AppError('Falta la cantidad contada');
    if (p.kind !== 'COUNT' && item.delta === 0) throw new AppError('El ajuste no puede ser cero');
  }
  await tx.adjustment.create({
    data: { id: p.adjustmentId, tenantId: ctx.tenantId, branchId: p.branchId, kind: p.kind, reason: p.reason, items: p.items, requestedBy: ctx.userId, requestedAt: meta.time },
  });
  return { adjustmentId: p.adjustmentId };
};

type AdjItem = { variantId: string; lotId?: string | null; delta: number; countedQty?: number | null; expectedQty?: number | null };

export const reviewAdjustment: Handler<'adjustment.review'> = async (tx, ctx, p, meta) => {
  const found = await tx.adjustment.findFirst({ where: { tenantId: ctx.tenantId, id: p.adjustmentId } });
  if (!found) throw notFound('Ajuste');
  needBranch(ctx, found.branchId);
  await lock(tx, `branch:${ctx.tenantId}:${found.branchId}`);
  const adj = await tx.adjustment.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id: p.adjustmentId } });
  if (adj.status !== 'PENDING') throw conflict('El ajuste ya fue revisado');
  let items = adj.items as unknown as AdjItem[];
  if (p.approve) {
    const variants = await getVariants(tx, ctx, items.map((i) => i.variantId));
    const applied: AdjItem[] = [];
    for (const item of items) {
      let delta = item.delta;
      let expected = item.expectedQty;
      if (adj.kind === 'COUNT') {
        // Conciliación contra el stock que había en el momento del conteo.
        expected = await stockAt(tx, ctx, adj.branchId, item.variantId, item.lotId ?? null, adj.requestedAt);
        delta = round3((item.countedQty ?? 0) - expected);
      }
      applied.push({ ...item, delta, expectedQty: expected });
      const allocations = delta < 0 && !item.lotId
        ? (await allocateOut(tx, ctx, adj.branchId, item.variantId, -delta)).map((a) => ({ lotId: a.lotId, quantity: -a.quantity }))
        : [{ lotId: item.lotId ?? null, quantity: delta }];
      await addMovements(tx, ctx, allocations.map((a) => ({
        branchId: adj.branchId, variantId: item.variantId, lotId: a.lotId, type: adj.kind, quantity: a.quantity,
        unitCost: Number(variants.get(item.variantId)?.cost ?? 0), reason: adj.reason, refType: 'adjustment', refId: adj.id, occurredAt: meta.time,
      })));
    }
    items = applied;
  }
  await tx.adjustment.update({
    where: { id: adj.id },
    data: { status: p.approve ? 'APPROVED' : 'REJECTED', reviewedBy: ctx.userId, reviewedAt: meta.time, items },
  });
  await audit(tx, ctx, p.approve ? 'adjustment.approve' : 'adjustment.reject', 'Adjustment', adj.id, { kind: adj.kind, items });
  return { adjustmentId: adj.id };
};
