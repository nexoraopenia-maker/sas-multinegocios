/** Aplica las operaciones aún no sincronizadas sobre los datos guardados, para ver el stock real sin red. */
import { round3 } from '@/shared/money';
import type { Payload } from '@/shared/operations';
import type { Snapshot } from '@/shared/snapshot';
import { allocateFefo } from '@/shared/stock';
import type { OutboxItem } from './idb';

export function applyPending(base: Snapshot, items: OutboxItem[]): Snapshot {
  const pending = items.filter((i) => i.status !== 'REJECTED');
  if (!pending.length) return base;
  const s: Snapshot = {
    ...base, balances: base.balances.map((b) => ({ ...b })), lots: [...base.lots], customers: [...base.customers],
    transfers: base.transfers.map((t) => ({ ...t, items: t.items.map((i) => ({ ...i })) })), adjustments: [...base.adjustments],
  };
  const move = (branchId: string, variantId: string, lotId: string | null, delta: number) => {
    const row = s.balances.find((b) => b.branchId === branchId && b.variantId === variantId && b.lotId === lotId);
    if (row) row.quantity = round3(row.quantity + delta);
    else s.balances.push({ branchId, variantId, lotId, quantity: delta });
  };
  const takeOut = (branchId: string, variantId: string, quantity: number, lotId?: string | null) => {
    if (lotId) return move(branchId, variantId, lotId, -quantity);
    const rows = s.balances.filter((b) => b.branchId === branchId && b.variantId === variantId);
    const lots = rows.map((r) => ({ lotId: r.lotId ?? '', expiresAt: s.lots.find((l) => l.id === r.lotId)?.expiresAt ?? null, quantity: r.quantity }));
    for (const a of allocateFefo(lots, quantity)) move(branchId, variantId, a.lotId || null, -a.quantity);
  };

  for (const { op, userId, deviceKey } of pending) {
    switch (op.type) {
      case 'sale.create': {
        const p = op.payload as Payload<'sale.create'>;
        if (p.branchId !== base.branchId) break;
        for (const i of p.items) takeOut(p.branchId, i.variantId, i.quantity, i.lotId);
        if (p.customer && !s.customers.some((c) => c.id === p.customer!.id)) s.customers.unshift(p.customer);
        break;
      }
      case 'stock.in': {
        const p = op.payload as Payload<'stock.in'>;
        for (const i of p.items) {
          let lotId: string | null = null;
          if (i.lotCode || i.expiresAt) {
            const code = i.lotCode || `V-${i.expiresAt}`;
            let lot = s.lots.find((l) => l.variantId === i.variantId && l.code === code);
            if (!lot) { lot = { id: `local:${i.variantId}:${code}`, variantId: i.variantId, code, expiresAt: i.expiresAt ?? null }; s.lots.push(lot); }
            lotId = lot.id;
          }
          move(p.branchId, i.variantId, lotId, i.quantity);
        }
        break;
      }
      case 'cash.open': {
        const p = op.payload as Payload<'cash.open'>;
        if (p.branchId === base.branchId) s.cashSession = { id: p.cashSessionId, branchId: p.branchId, deviceKey, userId, openedAt: op.clientTime, openingAmount: p.openingAmount };
        break;
      }
      case 'cash.close':
        if (s.cashSession?.id === (op.payload as Payload<'cash.close'>).cashSessionId) s.cashSession = null;
        break;
      case 'adjustment.request': {
        const p = op.payload as Payload<'adjustment.request'>;
        if (!s.adjustments.some((a) => a.id === p.adjustmentId)) {
          s.adjustments.unshift({ id: p.adjustmentId, branchId: p.branchId, kind: p.kind, status: 'PENDING', reason: p.reason, requestedAt: op.clientTime, requestedByName: 'Pendiente de envío', items: p.items.map((i) => ({ ...i, lotId: i.lotId ?? null })) });
        }
        break;
      }
      case 'transfer.request': {
        const p = op.payload as Payload<'transfer.request'>;
        if (!s.transfers.some((t) => t.id === p.transferId)) {
          s.transfers.unshift({ id: p.transferId, fromBranchId: p.fromBranchId, toBranchId: p.toBranchId, status: 'REQUESTED', notes: p.notes, requestedAt: op.clientTime, items: p.items.map((i) => ({ variantId: i.variantId, requested: i.quantity, shipped: 0, received: 0 })) });
        }
        break;
      }
      case 'transfer.cancel': {
        const t = s.transfers.find((x) => x.id === (op.payload as Payload<'transfer.cancel'>).transferId);
        if (t) t.status = 'CANCELLED';
        break;
      }
      case 'transfer.ship': case 'transfer.receive': {
        const p = op.payload as Payload<'transfer.ship'>;
        const t = s.transfers.find((x) => x.id === p.transferId);
        if (!t) break;
        const shipping = op.type === 'transfer.ship';
        for (const i of p.items) {
          const line = t.items.find((x) => x.variantId === i.variantId);
          if (line) line[shipping ? 'shipped' : 'received'] = i.quantity;
          if (!i.quantity) continue;
          if (shipping) takeOut(t.fromBranchId, i.variantId, i.quantity);
          else move(t.toBranchId, i.variantId, null, i.quantity);
        }
        t.status = shipping ? 'SHIPPED' : 'RECEIVED';
        break;
      }
    }
  }
  return s;
}
