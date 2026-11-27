/** Dígito de control EAN-13 para 12 dígitos. */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/** Código de barras interno: prefijo 2 (uso en tienda) + correlativo del negocio. */
export function internalBarcode(sequence: number): string {
  const base = '2' + String(sequence).padStart(11, '0');
  return base + ean13CheckDigit(base);
}

export const isEan13 = (code: string) =>
  /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);

export function internalSku(categoryName: string, sequence: number): string {
  const prefix = categoryName.normalize('NFD').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'PRD';
  return `${prefix}-${String(sequence).padStart(6, '0')}`;
}

export const receiptNumber = (series: string, number: number) => `${series}-${String(number).padStart(6, '0')}`;
