import { round3 } from './money';

export interface LotStock { lotId: string; expiresAt: string | null; quantity: number }
export interface Allocation { lotId: string | null; quantity: number }

/**
 * FEFO: consume primero el lote que vence antes (sin fecha al final).
 * Si el stock no alcanza, el faltante queda sin lote (el saldo puede quedar negativo y se alerta).
 * Los lotes ya vencidos se usan solo si no queda otra opción.
 */
export function allocateFefo(lots: LotStock[], quantity: number, today = todayISO()): Allocation[] {
  const rank = (l: LotStock) => (l.expiresAt === null ? '1|9999' : l.expiresAt < today ? `2|${l.expiresAt}` : `0|${l.expiresAt}`);
  const sorted = lots.filter((l) => l.quantity > 0).sort((a, b) => rank(a).localeCompare(rank(b)));
  const out: Allocation[] = [];
  let remaining = quantity;
  for (const lot of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(lot.quantity, remaining);
    out.push({ lotId: lot.lotId, quantity: round3(take) });
    remaining = round3(remaining - take);
  }
  if (remaining > 0) out.push({ lotId: null, quantity: remaining });
  return out;
}

/** Fecha local (America/Lima por defecto) en formato YYYY-MM-DD. */
export function todayISO(date = new Date(), timeZone = 'America/Lima'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
