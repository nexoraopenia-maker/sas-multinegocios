import { randomBytes } from 'node:crypto';
import { money, round2, round3, saleTotals } from '@/shared/money';
import { variantLabel } from '@/shared/snapshot';
import type { AttributeValues } from '@/shared/attributes';
import type { Payload } from '@/shared/operations';
import { receiptNumber } from '@/shared/codes';
import { audit } from '../audit';
import { needBranch, type Ctx } from '../context';
import { lock } from '../db';
import { AppError, conflict, notFound } from '../errors';
import { addMovements, allocateOut, assertLot, getVariants, notice, type MovementInput } from './stock';
import type { Handler } from './types';

const PRICE_GRACE_MS = 60 * 24 * 3600_000;

export const createSale: Handler<'sale.create'> = async (tx, ctx, p, meta) => {
  needBranch(ctx, p.branchId);
  await lock(tx, `branch:${ctx.tenantId}:${p.branchId}`);
  const device = await tx.device.findFirst({ where: { tenantId: ctx.tenantId, deviceKey: meta.deviceKey, branchId: p.branchId } });
  if (!device || device.series !== p.series) throw new AppError('La serie del comprobante no corresponde a este dispositivo');
  if (await tx.sale.findFirst({ where: { tenantId: ctx.tenantId, OR: [{ id: p.saleId }, { series: p.series, number: p.number }] } })) {
    throw conflict(`El comprobante ${receiptNumber(p.series, p.number)} ya existe`);
  }

  const settings = await tx.tenantSettings.findUniqueOrThrow({ where: { tenantId: ctx.tenantId } });
  const variants = await getVariants(tx, ctx, p.items.map((i) => i.variantId));
  const reviews: string[] = [];

  for (const item of p.items) {
    const v = variants.get(item.variantId);
    if (!v) throw notFound('Producto');
    const gross = round2(item.quantity * item.unitPrice);
    if (item.discount > gross) throw new AppError(`El descuento supera el importe de ${v.product.name}`);
    if (!ctx.permissions.has('pos.discount') && item.discount > round2((gross * Number(settings.maxSellerDiscountPct)) / 100) + 0.01) {
      throw new AppError(`Descuento mayor al permitido (${Number(settings.maxSellerDiscountPct)}%) en ${v.product.name}`, 403, 'DISCOUNT_LIMIT');
    }
    if (Math.abs(item.unitPrice - Number(v.price)) > 0.001 && !ctx.permissions.has('prices.manage')) {
      // Venta sin conexión con un precio anterior: se acepta si ese precio estuvo vigente y se marca para revisión.
      const known = await tx.priceHistory.findFirst({
        where: { tenantId: ctx.tenantId, variantId: v.id, price: item.unitPrice },
        orderBy: { createdAt: 'desc' },
      });
      const superseded = known && (await tx.priceHistory.findFirst({
        where: { tenantId: ctx.tenantId, variantId: v.id, id: { gt: known.id } }, orderBy: { id: 'asc' },
      }));
      if (!known || (superseded && Date.now() - superseded.createdAt.getTime() > PRICE_GRACE_MS)) {
        throw new AppError(`Precio no autorizado para ${v.product.name}`, 403, 'PRICE_NOT_ALLOWED');
      }
      reviews.push(`${v.product.name}: vendido a ${money(item.unitPrice)}, precio actual ${money(Number(v.price))}`);
    }
    if (!v.active) reviews.push(`${v.product.name}: producto desactivado`);
  }

  const totals = saleTotals(p.items);
  const paid = round2(p.payments.reduce((s, x) => s + x.amount, 0));
  if (Math.abs(paid - totals.total) > 0.001) throw new AppError(`Los pagos (${money(paid)}) no coinciden con el total (${money(totals.total)})`);

  for (const pay of p.payments.filter((x) => x.method === 'VOUCHER')) {
    const used = await tx.voucher.updateMany({
      where: { tenantId: ctx.tenantId, code: pay.reference.toUpperCase(), balance: { gte: pay.amount } },
      data: { balance: { decrement: pay.amount } },
    });
    if (used.count !== 1) throw new AppError('El vale no existe o no tiene saldo suficiente');
  }

  let cashSessionId: string | null = null;
  if (p.cashSessionId) {
    const session = await tx.cashSession.findFirst({ where: { tenantId: ctx.tenantId, id: p.cashSessionId, branchId: p.branchId } });
    if (session) cashSessionId = session.id;
    if (!session || session.closedAt) reviews.push('La venta llegó sin una caja abierta válida');
  } else reviews.push('Venta registrada sin caja abierta');

  let customerId: string | null = null;
  if (p.customer) {
    const found = await tx.customer.findFirst({ where: { tenantId: ctx.tenantId, id: p.customer.id } });
    customerId = (found ?? (await tx.customer.create({ data: { ...p.customer, tenantId: ctx.tenantId } }))).id;
  } else if (p.customerId) {
    const found = await tx.customer.findFirst({ where: { tenantId: ctx.tenantId, id: p.customerId } });
    if (!found) throw notFound('Cliente');
    customerId = found.id;
  }

  await tx.sale.create({
    data: {
      id: p.saleId, tenantId: ctx.tenantId, branchId: p.branchId, deviceKey: meta.deviceKey, series: p.series, number: p.number,
      userId: ctx.userId, customerId, cashSessionId, subtotal: totals.subtotal, discount: totals.discount, total: totals.total,
      occurredAt: meta.time,
    },
  });
  await tx.saleItem.createMany({
    data: p.items.map((item, i) => {
      const v = variants.get(item.variantId)!;
      return {
        tenantId: ctx.tenantId, saleId: p.saleId, variantId: v.id,
        description: variantLabel(v.product, { attributes: v.attributes as AttributeValues }),
        quantity: item.quantity, unitPrice: item.unitPrice, discount: item.discount, total: totals.lines[i], unitCost: v.cost,
      };
    }),
  });
  if (p.payments.length) {
    await tx.payment.createMany({
      data: p.payments.map((x) => ({
        tenantId: ctx.tenantId, saleId: p.saleId, method: x.method, amount: x.amount, reference: x.reference, cashSessionId, occurredAt: meta.time,
      })),
    });
  }

  for (const item of p.items) {
    const v = variants.get(item.variantId)!;
    let allocations;
    if (item.lotId) {
      if (!(await assertLot(tx, ctx, v.id, item.lotId))) throw notFound('Lote');
      allocations = [{ lotId: item.lotId, quantity: item.quantity }];
    } else allocations = await allocateOut(tx, ctx, p.branchId, v.id, item.quantity);
    // Se insertan por línea para que la siguiente línea vea el saldo actualizado.
    await addMovements(tx, ctx, allocations.map((a): MovementInput => ({
      branchId: p.branchId, variantId: v.id, lotId: a.lotId, type: 'SALE', quantity: -a.quantity, unitCost: Number(v.cost),
      reason: `Venta ${receiptNumber(p.series, p.number)}`, refType: 'sale', refId: p.saleId, occurredAt: meta.time,
    })));
  }

  if (reviews.length) {
    await notice(tx, ctx.tenantId, 'PRICE_REVIEW', `Revisar venta ${receiptNumber(p.series, p.number)}: ${reviews.join('; ')}`, p.branchId, { saleId: p.saleId });
  }
  if (ctx.features.sunat && (await tx.sunatConfig.findUnique({ where: { tenantId: ctx.tenantId } }))) {
    await tx.electronicDocument.create({ data: { tenantId: ctx.tenantId, saleId: p.saleId, docType: '03', detail: 'En cola: envío a SUNAT pendiente de implementación' } });
  }
  return { saleId: p.saleId, receipt: receiptNumber(p.series, p.number), total: totals.total };
};

async function openSession(tx: Parameters<Handler<'sale.void'>>[0], ctx: Ctx, id: string | null | undefined, branchId: string) {
  if (!id) return null;
  const s = await tx.cashSession.findFirst({ where: { tenantId: ctx.tenantId, id, branchId, closedAt: null } });
  if (!s) throw new AppError('La caja indicada no está abierta en esta sucursal');
  return s.id;
}

export const voidSale: Handler<'sale.void'> = async (tx, ctx, p, meta) => {
  const found = await tx.sale.findFirst({ where: { tenantId: ctx.tenantId, id: p.saleId } });
  if (!found) throw notFound('Venta');
  needBranch(ctx, found.branchId);
  await lock(tx, `branch:${ctx.tenantId}:${found.branchId}`);
  const sale = await tx.sale.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id: p.saleId }, include: { payments: true } });
  if (sale.status !== 'COMPLETED') throw conflict('La venta ya está anulada');
  if (await tx.saleReturn.findFirst({ where: { tenantId: ctx.tenantId, saleId: sale.id } })) throw conflict('La venta tiene devoluciones; no se puede anular');
  const cashSessionId = await openSession(tx, ctx, p.cashSessionId, sale.branchId);
  if (!cashSessionId && sale.payments.some((x) => x.method === 'CASH' && Number(x.amount) > 0)) {
    throw new AppError('Abre la caja para devolver el efectivo de esta venta');
  }
  const movements = await tx.stockMovement.findMany({ where: { tenantId: ctx.tenantId, refType: 'sale', refId: sale.id, type: 'SALE' } });
  await addMovements(tx, ctx, movements.map((m) => ({
    branchId: m.branchId, variantId: m.variantId, lotId: m.lotId, type: 'SALE_VOID' as const, quantity: -Number(m.quantity),
    unitCost: Number(m.unitCost), reason: `Anulación ${receiptNumber(sale.series, sale.number)}: ${p.reason}`, refType: 'sale', refId: sale.id, occurredAt: meta.time,
  })));
  for (const pay of sale.payments) {
    if (pay.method === 'VOUCHER') {
      await tx.voucher.updateMany({ where: { tenantId: ctx.tenantId, code: pay.reference.toUpperCase() }, data: { balance: { increment: pay.amount } } });
    }
    await tx.payment.create({
      data: { tenantId: ctx.tenantId, saleId: sale.id, method: pay.method, amount: -Number(pay.amount), reference: pay.reference, cashSessionId, occurredAt: meta.time },
    });
  }
  await tx.sale.update({ where: { id: sale.id }, data: { status: 'VOIDED', voidReason: p.reason, voidedBy: ctx.userId, voidedAt: meta.time } });
  await audit(tx, ctx, 'sale.void', 'Sale', sale.id, { reason: p.reason, total: Number(sale.total) });
  return { saleId: sale.id };
};

export const returnSale: Handler<'sale.return'> = async (tx, ctx, p: Payload<'sale.return'>, meta) => {
  const found = await tx.sale.findFirst({ where: { tenantId: ctx.tenantId, id: p.saleId } });
  if (!found) throw notFound('Venta');
  needBranch(ctx, found.branchId);
  await lock(tx, `branch:${ctx.tenantId}:${found.branchId}`);
  const sale = await tx.sale.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id: p.saleId }, include: { items: true } });
  if (sale.status !== 'COMPLETED') throw conflict('La venta está anulada');
  if (new Set(p.items.map((i) => i.saleItemId)).size !== p.items.length) throw new AppError('Líneas repetidas en la devolución');
  const cashSessionId = await openSession(tx, ctx, p.cashSessionId, sale.branchId);
  if (p.refundMethod === 'CASH' && !cashSessionId) throw new AppError('Abre la caja para devolver efectivo');

  let total = 0;
  const movements: MovementInput[] = [];
  const lines: object[] = [];
  for (const req of p.items) {
    const line = sale.items.find((i) => i.id === req.saleItemId);
    if (!line) throw notFound('Línea de venta');
    const sold = Number(line.quantity);
    const returned = Number(line.returnedQty);
    if (req.quantity > round3(sold - returned) + 0.0001) throw new AppError(`Solo quedan ${round3(sold - returned)} por devolver de ${line.description}`);
    // Acumulado proporcional: la suma de devoluciones parciales nunca supera lo cobrado.
    const upTo = (q: number) => round2((Number(line.total) * q) / sold);
    const amount = round2(upTo(round3(returned + req.quantity)) - upTo(returned));
    total = round2(total + amount);
    lines.push({ saleItemId: line.id, variantId: line.variantId, description: line.description, quantity: req.quantity, amount, restock: req.restock });
    await tx.saleItem.update({ where: { id: line.id }, data: { returnedQty: { increment: req.quantity } } });

    // Reingresa a los mismos lotes de los que salió, descontando devoluciones previas.
    const history = await tx.stockMovement.findMany({
      where: { tenantId: ctx.tenantId, refType: 'sale', refId: sale.id, variantId: line.variantId, type: { in: ['SALE', 'RETURN'] } },
    });
    const pending = new Map<string, number>();
    for (const m of history) pending.set(m.lotId ?? '', round3((pending.get(m.lotId ?? '') ?? 0) - Number(m.quantity)));
    let remaining = req.quantity;
    for (const [lotId, available] of pending) {
      const take = Math.min(remaining, available);
      if (take <= 0) continue;
      remaining = round3(remaining - take);
      const common = { branchId: sale.branchId, variantId: line.variantId, lotId: lotId || null, unitCost: Number(line.unitCost), refType: 'sale', refId: sale.id, occurredAt: meta.time };
      movements.push({ ...common, type: 'RETURN', quantity: take, reason: `Devolución: ${p.reason}` });
      if (!req.restock) movements.push({ ...common, type: 'WASTE', quantity: -take, reason: `Devuelto no vendible: ${p.reason}` });
    }
  }
  await addMovements(tx, ctx, movements);
  await tx.saleReturn.create({
    data: { id: p.returnId, tenantId: ctx.tenantId, saleId: sale.id, branchId: sale.branchId, userId: ctx.userId, total, refundMethod: p.refundMethod, reason: p.reason, items: lines, occurredAt: meta.time },
  });
  let voucherCode: string | null = null;
  if (p.refundMethod === 'VOUCHER') {
    voucherCode = `V-${randomBytes(5).toString('hex').toUpperCase()}`;
    await tx.voucher.create({ data: { tenantId: ctx.tenantId, code: voucherCode, amount: total, balance: total, returnId: p.returnId } });
  } else if (total > 0) {
    await tx.payment.create({
      data: { tenantId: ctx.tenantId, saleId: sale.id, method: p.refundMethod, amount: -total, reference: 'Devolución', cashSessionId, occurredAt: meta.time },
    });
  }
  await audit(tx, ctx, 'sale.return', 'Sale', sale.id, { total, reason: p.reason, refundMethod: p.refundMethod });
  return { returnId: p.returnId, total, voucherCode };
};
