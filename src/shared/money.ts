export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
export const money = (n: number, currency = 'PEN') =>
  `${currency === 'PEN' ? 'S/' : currency} ${round2(n).toFixed(2)}`;

export interface LineInput { quantity: number; unitPrice: number; discount: number }

/** Totales de una venta. Mismo cálculo en el dispositivo y en el servidor. */
export function saleTotals(items: LineInput[]) {
  let subtotal = 0;
  let discount = 0;
  const lines = items.map((i) => {
    const gross = round2(i.quantity * i.unitPrice);
    subtotal = round2(subtotal + gross);
    discount = round2(discount + i.discount);
    return round2(gross - i.discount);
  });
  return { subtotal, discount, total: round2(subtotal - discount), lines };
}
