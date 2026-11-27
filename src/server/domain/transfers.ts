import { round3 } from '@/shared/money';
import { audit } from '../audit';
import { forbidden, AppError, conflict, notFound } from '../errors';
import { needBranch, needFeature, type Ctx } from '../context';
import { lock, type Tx } from '../db';
import { addMovements, allocateOut, getVariants, notice } from './stock';
import type { Handler } from './types';
import type { TransferStatus } from '@/generated/prisma/client';

async function load(tx: Tx, ctx: Ctx, id: string, expected: TransferStatus[]) {
  needFeature(ctx, 'multiBranch');
  await lock(tx, `transfer:${ctx.tenantId}:${id}`);
  const t = await tx.transfer.findFirst({ where: { tenantId: ctx.tenantId, id }, include: { items: true } });
  if (!t) throw notFound('Traslado');
  if (!expected.includes(t.status)) throw conflict(`El traslado está en estado ${t.status} y no admite esta acción`);
  return t;
}

export const requestTransfer: Handler<'transfer.request'> = async (tx, ctx, p, meta) => {
  needFeature(ctx, 'multiBranch');
  if (p.fromBranchId === p.toBranchId) throw new AppError('El origen y el destino deben ser distintos');
  if (!ctx.branchIds.includes(p.toBranchId) && !ctx.branchIds.includes(p.fromBranchId)) throw forbidden('No participas en ese traslado');
  const branches = await tx.branch.count({ where: { tenantId: ctx.tenantId, id: { in: [p.fromBranchId, p.toBranchId] }, active: true } });
  if (branches !== 2) throw notFound('Sucursal');
  if (new Set(p.items.map((i) => i.variantId)).size !== p.items.length) throw new AppError('Hay productos repetidos');
  const variants = await getVariants(tx, ctx, p.items.map((i) => i.variantId));
  if (variants.size !== p.items.length) throw notFound('Producto');
  await tx.transfer.create({
    data: { id: p.transferId, tenantId: ctx.tenantId, fromBranchId: p.fromBranchId, toBranchId: p.toBranchId, notes: p.notes, requestedBy: ctx.userId, requestedAt: meta.time },
  });
  await tx.transferItem.createMany({ data: p.items.map((i) => ({ tenantId: ctx.tenantId, transferId: p.transferId, variantId: i.variantId, requested: i.quantity })) });
  return { transferId: p.transferId };
};

export const reviewTransfer: Handler<'transfer.review'> = async (tx, ctx, p, meta) => {
  const t = await load(tx, ctx, p.transferId, ['REQUESTED']);
  needBranch(ctx, t.fromBranchId);
  await tx.transfer.update({ where: { id: t.id }, data: { status: p.approve ? 'APPROVED' : 'REJECTED', approvedBy: ctx.userId, approvedAt: meta.time } });
  await audit(tx, ctx, p.approve ? 'transfer.approve' : 'transfer.reject', 'Transfer', t.id);
  return { transferId: t.id };
};

export const cancelTransfer: Handler<'transfer.cancel'> = async (tx, ctx, p) => {
  const t = await load(tx, ctx, p.transferId, ['REQUESTED', 'APPROVED']);
  if (t.requestedBy !== ctx.userId && !ctx.permissions.has('transfer.approve')) throw forbidden();
  if (!ctx.branchIds.includes(t.fromBranchId) && !ctx.branchIds.includes(t.toBranchId)) throw forbidden('No participas en ese traslado');
  await tx.transfer.update({ where: { id: t.id }, data: { status: 'CANCELLED' } });
  await audit(tx, ctx, 'transfer.cancel', 'Transfer', t.id);
  return { transferId: t.id };
};

type Shipped = { lotId: string | null; quantity: number };

export const shipTransfer: Handler<'transfer.ship'> = async (tx, ctx, p, meta) => {
  const t = await load(tx, ctx, p.transferId, ['APPROVED']);
  needBranch(ctx, t.fromBranchId);
  await lock(tx, `branch:${ctx.tenantId}:${t.fromBranchId}`);
  const variants = await getVariants(tx, ctx, t.items.map((i) => i.variantId));
  if (p.items.some((i) => !t.items.some((x) => x.variantId === i.variantId))) throw new AppError('Hay productos que no pertenecen al traslado');
  let sent = 0;
  for (const item of t.items) {
    const quantity = p.items.find((i) => i.variantId === item.variantId)?.quantity ?? 0;
    if (quantity > Number(item.requested)) throw new AppError('No se puede enviar más de lo solicitado');
    if (quantity === 0) continue;
    sent += quantity;
    const lots = await allocateOut(tx, ctx, t.fromBranchId, item.variantId, quantity);
    await addMovements(tx, ctx, lots.map((a) => ({
      branchId: t.fromBranchId, variantId: item.variantId, lotId: a.lotId, type: 'TRANSFER_OUT' as const, quantity: -a.quantity,
      unitCost: Number(variants.get(item.variantId)?.cost ?? 0), reason: 'Envío de traslado', refType: 'transfer', refId: t.id, occurredAt: meta.time,
    })));
    await tx.transferItem.update({ where: { id: item.id }, data: { shipped: quantity, shippedLots: lots as unknown as object[] } });
  }
  if (sent === 0) throw new AppError('Indica al menos una cantidad a enviar');
  await tx.transfer.update({ where: { id: t.id }, data: { status: 'SHIPPED', shippedBy: ctx.userId, shippedAt: meta.time } });
  return { transferId: t.id };
};

export const receiveTransfer: Handler<'transfer.receive'> = async (tx, ctx, p, meta) => {
  const t = await load(tx, ctx, p.transferId, ['SHIPPED']);
  needBranch(ctx, t.toBranchId);
  await lock(tx, `branch:${ctx.tenantId}:${t.toBranchId}`);
  const variants = await getVariants(tx, ctx, t.items.map((i) => i.variantId));
  const differences: string[] = [];
  for (const item of t.items) {
    const shipped = Number(item.shipped);
    const received = p.items.find((i) => i.variantId === item.variantId)?.quantity ?? 0;
    if (received > shipped) throw new AppError('No se puede recibir más de lo enviado');
    if (shipped === 0) continue;
    const base = {
      branchId: t.toBranchId, variantId: item.variantId, unitCost: Number(variants.get(item.variantId)?.cost ?? 0),
      refType: 'transfer', refId: t.id, occurredAt: meta.time,
    };
    // Entra todo lo enviado y el faltante se registra como merma, para que el kárdex quede completo.
    let missing = round3(shipped - received);
    for (const lot of [...((item.shippedLots ?? []) as unknown as Shipped[])].reverse()) {
      await addMovements(tx, ctx, [{ ...base, lotId: lot.lotId, type: 'TRANSFER_IN', quantity: lot.quantity, reason: 'Recepción de traslado' }]);
      const lost = Math.min(missing, lot.quantity);
      if (lost > 0) {
        await addMovements(tx, ctx, [{ ...base, lotId: lot.lotId, type: 'WASTE', quantity: -lost, reason: 'Faltante en traslado' }]);
        missing = round3(missing - lost);
      }
    }
    if (received < shipped) differences.push(`${variants.get(item.variantId)?.product.name}: enviado ${shipped}, recibido ${received}`);
    await tx.transferItem.update({ where: { id: item.id }, data: { received } });
  }
  await tx.transfer.update({ where: { id: t.id }, data: { status: 'RECEIVED', receivedBy: ctx.userId, receivedAt: meta.time } });
  if (differences.length) await notice(tx, ctx.tenantId, 'TRANSFER_DIFFERENCE', `Diferencias en traslado: ${differences.join('; ')}`, t.toBranchId, { transferId: t.id });
  return { transferId: t.id };
};
