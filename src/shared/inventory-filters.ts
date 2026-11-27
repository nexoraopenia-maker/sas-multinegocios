import { computeAlerts, type AlertSwitches } from './alerts';
import { round3 } from './money';
import { variantLabel, type Snapshot } from './snapshot';

export const STOCK_FILTERS = { all: 'Todos', in: 'Con stock', out: 'Sin stock', low: 'Bajo stock', expired: 'Vencidos', expiring: 'Por vencer' } as const;
export type StockFilter = keyof typeof STOCK_FILTERS;
export const isStockFilter = (v: string): v is StockFilter => Object.hasOwn(STOCK_FILTERS, v);

/** Filtros disponibles: los de alertas solo si están activadas y el usuario puede verlas. */
export function availableFilters(switches: AlertSwitches, canSeeAlerts: boolean): StockFilter[] {
  const alert: Partial<Record<StockFilter, boolean>> = { low: switches.lowStock, expired: switches.expired, expiring: switches.expiring };
  return (Object.keys(STOCK_FILTERS) as StockFilter[]).filter((f) => !(f in alert) || (canSeeAlerts && alert[f]));
}

/** Variantes de la sucursal que cumplen el filtro; null = sin filtrar. */
export function filterVariants(view: Snapshot, branchId: string, filter: StockFilter, switches: AlertSwitches, today?: string): Set<string> | null {
  if (filter === 'all') return null;
  if (filter === 'in' || filter === 'out') {
    const totals = new Map<string, number>();
    for (const b of view.balances) if (b.branchId === branchId) totals.set(b.variantId, round3((totals.get(b.variantId) ?? 0) + b.quantity));
    return new Set(view.variants.filter((v) => ((totals.get(v.id) ?? 0) > 0) === (filter === 'in')).map((v) => v.id));
  }
  const products = new Map(view.products.map((p) => [p.id, p]));
  const alerts = computeAlerts({
    variants: view.variants.flatMap((v) => {
      const p = products.get(v.productId);
      return p ? [{ id: v.id, label: variantLabel(p, v), sku: v.sku, minStock: v.minStock, tracksExpiry: p.tracksExpiry, active: v.active && p.active }] : [];
    }),
    balances: view.balances, lots: view.lots, branchIds: [branchId], switches, today,
  });
  return new Set(alerts[filter === 'low' ? 'lowStock' : filter].map((a) => a.variantId));
}
