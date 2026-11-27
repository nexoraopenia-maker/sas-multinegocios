import { money, round2 } from '@/shared/money';
import { audit } from '../audit';
import { needBranch, type Ctx } from '../context';
import { lock, type Tx } from '../db';
import { conflict, forbidden, notFound } from '../errors';
import { notice } from './stock';
import type { Handler } from './types';

export const openCash: Handler<'cash.open'> = async (tx, ctx, p, meta) => {
  needBranch(ctx, p.branchId);
  await lock(tx, `branch:${ctx.tenantId}:${p.branchId}`);
  const open = await tx.cashSession.findFirst({ where: { tenantId: ctx.tenantId, branchId: p.branchId, deviceKey: meta.deviceKey, closedAt: null } });
  if (open) throw conflict('Este dispositivo ya tiene una caja abierta');
  await tx.cashSession.create({
    data: { id: p.cashSessionId, tenantId: ctx.tenantId, branchId: p.branchId, userId: ctx.userId, deviceKey: meta.deviceKey, openedAt: meta.time, openingAmount: p.openingAmount },
  });
  return { cashSessionId: p.cashSessionId };
};

async function loadOpen(tx: Tx, ctx: Ctx, id: string) {
  await lock(tx, `cash:${ctx.tenantId}:${id}`);
  const s = await tx.cashSession.findFirst({ where: { tenantId: ctx.tenantId, id } });
  if (!s) throw notFound('Caja');
  needBranch(ctx, s.branchId);
  if (s.closedAt) throw conflict('La caja ya está cerrada');
  if (s.userId !== ctx.userId && !ctx.permissions.has('cash.review')) throw forbidden('La caja pertenece a otro usuario');
  return s;
}

export const cashMovement: Handler<'cash.movement'> = async (tx, ctx, p, meta) => {
  const s = await loadOpen(tx, ctx, p.cashSessionId);
  await tx.cashMovement.create({
    data: { tenantId: ctx.tenantId, cashSessionId: s.id, type: p.type, amount: p.amount, reason: p.reason, userId: ctx.userId, occurredAt: meta.time },
  });
  return { cashSessionId: s.id };
};

/** Efectivo esperado = apertura + cobros − reembolsos + ingresos − retiros. Los demás medios, sus cobros netos. */
export async function expectedTotals(tx: Tx, ctx: Ctx, sessionId: string, opening: number) {
  const expected: Record<string, number> = { CASH: opening, YAPE: 0, PLIN: 0, CARD: 0, TRANSFER: 0 };
  const pays = await tx.payment.groupBy({ by: ['method'], where: { tenantId: ctx.tenantId, cashSessionId: sessionId }, _sum: { amount: true } });
  for (const row of pays) if (row.method !== 'VOUCHER') expected[row.method] = round2(expected[row.method] + Number(row._sum.amount ?? 0));
  const moves = await tx.cashMovement.findMany({ where: { tenantId: ctx.tenantId, cashSessionId: sessionId } });
  for (const m of moves) expected.CASH = round2(expected.CASH + (m.type === 'IN' ? 1 : -1) * Number(m.amount));
  return expected;
}

export const closeCash: Handler<'cash.close'> = async (tx, ctx, p, meta) => {
  const s = await loadOpen(tx, ctx, p.cashSessionId);
  const expected = await expectedTotals(tx, ctx, s.id, Number(s.openingAmount));
  const counted = p.counted as Record<string, number>;
  const difference = round2(Object.keys(expected).reduce((sum, k) => sum + (counted[k] ?? 0) - expected[k], 0));
  await tx.cashSession.update({ where: { id: s.id }, data: { closedAt: meta.time, expected, counted, difference, notes: p.notes } });
  const mismatched = Object.keys(expected).filter((k) => Math.abs((counted[k] ?? 0) - expected[k]) > 0.001);
  if (mismatched.length) {
    await notice(tx, ctx.tenantId, 'CASH_REVIEW', `Cierre de caja con diferencia de ${money(difference)} (${mismatched.join(', ')})`, s.branchId, { cashSessionId: s.id });
  }
  await audit(tx, ctx, 'cash.close', 'CashSession', s.id, { expected, counted, difference });
  return { cashSessionId: s.id, expected, difference };
};
