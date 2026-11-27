import { addDays, todayISO } from './stock';
import { round3 } from './money';

export interface AlertVariant { id: string; label: string; sku: string; minStock: number; tracksExpiry: boolean; active: boolean }
export interface AlertBalance { branchId: string; variantId: string; lotId: string | null; quantity: number }
export interface AlertLot { id: string; variantId: string; code: string; expiresAt: string | null }
export interface AlertSwitches { expired: boolean; expiring: boolean; lowStock: boolean; daysAhead: number }

export interface ExpiryAlert { variantId: string; label: string; sku: string; branchId: string; lotCode: string; expiresAt: string; quantity: number }
export interface LowStockAlert { variantId: string; label: string; sku: string; branchId: string; quantity: number; minStock: number }

/** Cálculo único de alertas: se usa en el servidor y, sin internet, en el dispositivo. */
export function computeAlerts(input: {
  variants: AlertVariant[]; balances: AlertBalance[]; lots: AlertLot[];
  branchIds: string[]; switches: AlertSwitches; today?: string;
}) {
  const today = input.today ?? todayISO();
  const limit = addDays(today, input.switches.daysAhead);
  const variants = new Map(input.variants.map((v) => [v.id, v]));
  const lots = new Map(input.lots.map((l) => [l.id, l]));
  const branches = new Set(input.branchIds);
  const totals = new Map<string, number>();
  const expired: ExpiryAlert[] = [];
  const expiring: ExpiryAlert[] = [];

  for (const b of input.balances) {
    if (!branches.has(b.branchId)) continue;
    const key = `${b.branchId}|${b.variantId}`;
    totals.set(key, round3((totals.get(key) ?? 0) + b.quantity));
    const variant = variants.get(b.variantId);
    const lot = b.lotId ? lots.get(b.lotId) : undefined;
    // Solo productos con control de vencimiento activo y lotes con existencias.
    if (!variant?.active || !variant.tracksExpiry || !lot?.expiresAt || b.quantity <= 0) continue;
    const row = { variantId: variant.id, label: variant.label, sku: variant.sku, branchId: b.branchId, lotCode: lot.code, expiresAt: lot.expiresAt, quantity: b.quantity };
    if (lot.expiresAt < today) { if (input.switches.expired) expired.push(row); }
    else if (lot.expiresAt <= limit) { if (input.switches.expiring) expiring.push(row); }
  }

  const lowStock: LowStockAlert[] = [];
  if (input.switches.lowStock) {
    for (const v of input.variants) {
      if (!v.active || v.minStock <= 0) continue;
      for (const branchId of branches) {
        const quantity = totals.get(`${branchId}|${v.id}`) ?? 0;
        if (quantity <= v.minStock) lowStock.push({ variantId: v.id, label: v.label, sku: v.sku, branchId, quantity, minStock: v.minStock });
      }
    }
  }
  const byDate = (a: ExpiryAlert, b: ExpiryAlert) => a.expiresAt.localeCompare(b.expiresAt);
  return { expired: expired.sort(byDate), expiring: expiring.sort(byDate), lowStock: lowStock.sort((a, b) => a.quantity - b.quantity) };
}
