/**
 * QR impreso en comprobantes electrónicos peruanos:
 * RUC | TIPO | SERIE | NÚMERO | IGV | TOTAL | FECHA | TIPO DOC ADQ. | NÚM DOC ADQ. | [hash]
 * El QR no contiene el detalle de productos: sirve para precargar el documento y evitar duplicados.
 */
export interface SunatQr {
  supplierRuc: string; docType: string; series: string; number: string;
  igv: number; total: number; issueDate: string;
}

export function parseSunatQr(text: string): SunatQr | null {
  const parts = text.trim().split('|').map((p) => p.trim());
  if (parts.length < 7) return null;
  const [ruc, docType, series, number, igv, total, date] = parts;
  if (!/^\d{11}$/.test(ruc) || !/^\d{2}$/.test(docType) || !/^[A-Z0-9]{4}$/i.test(series) || !/^\d{1,8}$/.test(number)) return null;
  const totalN = Number(total);
  const igvN = Number(igv || 0);
  if (!Number.isFinite(totalN) || !Number.isFinite(igvN) || totalN < 0) return null;
  const dmy = date.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  const issueDate = dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
  return { supplierRuc: ruc, docType, series: series.toUpperCase(), number: String(Number(number)), igv: igvN, total: totalN, issueDate };
}

export const DOC_TYPES: Record<string, string> = { '01': 'Factura', '03': 'Boleta', '07': 'Nota de crédito', '08': 'Nota de débito' };
