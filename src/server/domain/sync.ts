import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OPERATION_LABELS, payloads, type Operation, type OperationType } from '@/shared/operations';
import type { Permission } from '@/shared/permissions';
import { need, needBranch, type Ctx } from '../context';
import { lock, withTenant } from '../db';
import { AppError, isUniqueViolation } from '../errors';
import { cashMovement, closeCash, openCash } from './cash';
import { requestAdjustment, reviewAdjustment, stockIn } from './inventory-ops';
import { createSale, returnSale, voidSale } from './sales';
import { notice } from './stock';
import { cancelTransfer, receiveTransfer, requestTransfer, reviewTransfer, shipTransfer } from './transfers';
import type { Handler } from './types';

const registry: { [T in OperationType]: { permission: Permission; run: Handler<T> } } = {
  'sale.create': { permission: 'pos.sell', run: createSale },
  'sale.void': { permission: 'sale.void', run: voidSale },
  'sale.return': { permission: 'sale.return', run: returnSale },
  'stock.in': { permission: 'stock.in', run: stockIn },
  'adjustment.request': { permission: 'stock.adjust.request', run: requestAdjustment },
  'adjustment.review': { permission: 'stock.adjust.approve', run: reviewAdjustment },
  'transfer.request': { permission: 'transfer.request', run: requestTransfer },
  'transfer.review': { permission: 'transfer.approve', run: reviewTransfer },
  'transfer.cancel': { permission: 'transfer.request', run: cancelTransfer },
  'transfer.ship': { permission: 'transfer.operate', run: shipTransfer },
  'transfer.receive': { permission: 'transfer.operate', run: receiveTransfer },
  'cash.open': { permission: 'cash.operate', run: openCash },
  'cash.movement': { permission: 'cash.operate', run: cashMovement },
  'cash.close': { permission: 'cash.operate', run: closeCash },
};

export interface OpResult { id: string; status: 'APPLIED' | 'REJECTED'; error?: string; result?: object; duplicate?: boolean }

const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v) ?? 'null';

/** Hora del dispositivo, acotada: nunca en el futuro ni absurdamente antigua. */
export function clampTime(clientTime: string, now = new Date()) {
  const t = new Date(clientTime);
  if (Number.isNaN(t.getTime()) || t.getTime() > now.getTime() + 5 * 60_000) return now;
  const oldest = now.getTime() - 45 * 24 * 3600_000;
  return t.getTime() < oldest ? new Date(oldest) : t;
}

/**
 * Aplica una operación exactamente una vez. Efectos e idempotencia se guardan en la misma
 * transacción. Los errores de negocio quedan registrados como REJECTED; los errores inesperados
 * se propagan para que el dispositivo reintente.
 */
export async function processOperation(ctx: Ctx, deviceKey: string, op: Operation): Promise<OpResult> {
  const hash = createHash('sha256').update(`${op.type}:${stable(op.payload)}`).digest('hex');
  const time = clampTime(op.clientTime);
  const previous = (row: { payloadHash: string; status: string; error: string | null; result: unknown }): OpResult =>
    row.payloadHash !== hash
      ? { id: op.id, status: 'REJECTED', error: 'La clave de idempotencia ya se usó con otros datos' }
      : { id: op.id, status: row.status as OpResult['status'], error: row.error ?? undefined, result: (row.result ?? undefined) as object | undefined, duplicate: true };
  const base = { tenantId: ctx.tenantId, id: op.id, userId: ctx.userId, deviceKey, type: op.type, payloadHash: hash, clientTime: time };

  try {
    return await withTenant(ctx.tenantId, async (tx) => {
      await lock(tx, `op:${ctx.tenantId}:${op.id}`);
      const row = await tx.syncOperation.findUnique({ where: { tenantId_id: { tenantId: ctx.tenantId, id: op.id } } });
      if (row) return previous(row);
      const entry = registry[op.type];
      need(ctx, entry.permission);
      const payload = payloads[op.type].parse(op.payload);
      const result = await (entry.run as Handler<OperationType>)(tx, ctx, payload as never, { time, deviceKey, opId: op.id });
      await tx.syncOperation.create({ data: { ...base, status: 'APPLIED', result } });
      return { id: op.id, status: 'APPLIED' as const, result };
    });
  } catch (e) {
    const message = e instanceof z.ZodError ? `Datos no válidos: ${e.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
      : e instanceof AppError ? e.message
        : isUniqueViolation(e) ? 'El registro ya existe (identificador repetido)' : null;
    if (message === null) throw e;
    return withTenant(ctx.tenantId, async (tx) => {
      await lock(tx, `op:${ctx.tenantId}:${op.id}`);
      const row = await tx.syncOperation.findUnique({ where: { tenantId_id: { tenantId: ctx.tenantId, id: op.id } } });
      if (row) return previous(row);
      await tx.syncOperation.create({ data: { ...base, status: 'REJECTED', error: message } });
      const branchId = (op.payload as { branchId?: unknown } | null)?.branchId;
      await notice(tx, ctx.tenantId, 'SYNC_REJECTED', `${OPERATION_LABELS[op.type]} de ${ctx.name} rechazada: ${message}`,
        typeof branchId === 'string' && ctx.branchIds.includes(branchId) ? branchId : null,
        { operationId: op.id, type: op.type, payload: op.payload as object });
      return { id: op.id, status: 'REJECTED' as const, error: message };
    });
  }
}

/** Registra el dispositivo en una sucursal y le asigna una serie propia de comprobantes. */
export async function registerDevice(ctx: Ctx, input: { deviceKey: string; branchId: string; name: string }) {
  needBranch(ctx, input.branchId);
  return withTenant(ctx.tenantId, async (tx) => {
    await lock(tx, `device:${ctx.tenantId}:${input.branchId}`);
    let device = await tx.device.findFirst({ where: { tenantId: ctx.tenantId, deviceKey: input.deviceKey, branchId: input.branchId } });
    if (!device) {
      const branch = await tx.branch.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id: input.branchId } });
      const key = `series:${branch.id}`;
      const counter = await tx.counter.upsert({
        where: { tenantId_key: { tenantId: ctx.tenantId, key } }, create: { tenantId: ctx.tenantId, key, value: 1 }, update: { value: { increment: 1 } },
      });
      device = await tx.device.create({
        data: { tenantId: ctx.tenantId, deviceKey: input.deviceKey, branchId: branch.id, name: input.name, series: `${branch.code}-${String(counter.value).padStart(2, '0')}` },
      });
    }
    const last = await tx.sale.aggregate({ where: { tenantId: ctx.tenantId, series: device.series }, _max: { number: true } });
    return { deviceKey: device.deviceKey, branchId: device.branchId, series: device.series, lastNumber: last._max.number ?? 0 };
  });
}
