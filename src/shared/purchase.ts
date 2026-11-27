/** Comprobantes de compra escaneados: archivos admitidos, borrador editable y emparejamiento con el catálogo. */
import { z } from 'zod';
import { round2, round3 } from './money';

/** Vercel limita el cuerpo de una petición a 4,5 MB. */
export const MAX_SCAN_BYTES = 4_000_000;
export const MAX_SCAN_PAGES = 10;
export const SCAN_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type ScanMime = (typeof SCAN_MIME)[number];

/** Tipo real según los primeros bytes: no se confía en la extensión ni en lo que declare el navegador. */
export function sniffMime(b: Uint8Array): ScanMime | null {
  const ascii = (from: number, text: string) => [...text].every((ch, i) => b[from + i] === ch.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && ascii(1, 'PNG')) return 'image/png';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, '%PDF-')) return 'application/pdf';
  return null;
}

/** Forma que debe devolver el modelo. */
export const extractionSchema = z.object({
  isPurchaseDocument: z.boolean(),
  docType: z.enum(['factura', 'boleta', 'otro']),
  supplierRuc: z.string(), supplierName: z.string(), series: z.string(), number: z.string(), issueDate: z.string(), currency: z.string(),
  total: z.number().nullable(), igv: z.number().nullable(),
  lines: z.array(z.object({
    description: z.string(), code: z.string(), quantity: z.number().nullable(), unitCost: z.number().nullable(), lineTotal: z.number().nullable(),
    lotCode: z.string(), expiresAt: z.string(),
  })),
});
export type Extraction = z.infer<typeof extractionSchema>;

export interface DraftLine { description: string; code: string; quantity: number; unitCost: number | null; lotCode: string; expiresAt: string }
export interface DocumentFields { docType: string; supplierRuc: string; series: string; number: string; issueDate: string; total: number | null; igv: number | null }
export interface PurchaseDraft extends DocumentFields { supplierName: string; currency: string; lines: DraftLine[]; warnings: string[] }

export interface PurchaseRef { createdAt: string; branch: string; total: number }
export interface ScanResult {
  scanId: string; status: 'DRAFT' | 'CONFIRMED'; reused: boolean; fileName: string; draft: PurchaseDraft; duplicate: PurchaseRef | null;
}

const clean = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);
const amount = (n: number | null) => (n !== null && Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? round2(n) : null);

export function validDate(s: string): string {
  const v = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : '';
}

/** Mismo formato que el QR de SUNAT (serie en mayúsculas, número sin ceros a la izquierda) para detectar duplicados. */
export function normalizeDocumentNumber(series: string, number: string) {
  let s = series.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  let n = number.trim();
  const joined = (n || s).toUpperCase().match(/^([A-Z0-9]{4})\s*-\s*(\d+)$/);
  if (joined) { s = joined[1]; n = joined[2]; }
  n = n.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  return { series: s.replace(/-/g, '').slice(0, 10), number: n.length <= 12 ? n : '' };
}

/** Limpia la respuesta del modelo: es texto no confiable que el usuario revisará. */
export function toDraft(raw: Extraction): PurchaseDraft {
  const warnings: string[] = [];
  const ruc = raw.supplierRuc.replace(/\D/g, '');
  if (ruc && ruc.length !== 11) warnings.push('El RUC leído no tiene 11 dígitos: complétalo si corresponde.');
  const currency = clean(raw.currency, 3).toUpperCase() || 'PEN';
  if (currency !== 'PEN') warnings.push(`El comprobante está en ${currency}: convierte los costos a soles antes de confirmar.`);
  const lines = raw.lines.slice(0, 200).map((l): DraftLine => {
    const quantity = l.quantity !== null && l.quantity > 0 && l.quantity <= 1_000_000 ? round3(l.quantity) : 0;
    const total = amount(l.lineTotal);
    return {
      description: clean(l.description, 150), code: clean(l.code, 60), quantity,
      unitCost: amount(l.unitCost) ?? (total !== null && quantity ? round2(total / quantity) : null),
      lotCode: clean(l.lotCode, 60), expiresAt: validDate(l.expiresAt),
    };
  }).filter((l) => l.description || l.code);
  if (lines.some((l) => !l.quantity)) warnings.push('Hay líneas sin cantidad legible.');
  if (raw.lines.length > 200) warnings.push('Solo se tomaron las primeras 200 líneas.');
  return {
    docType: raw.docType === 'factura' ? '01' : raw.docType === 'boleta' ? '03' : '',
    supplierRuc: ruc.length === 11 ? ruc : '', supplierName: clean(raw.supplierName, 150),
    ...normalizeDocumentNumber(raw.series, raw.number), issueDate: validDate(raw.issueDate), currency,
    total: amount(raw.total), igv: amount(raw.igv), lines, warnings,
  };
}

/**
 * Convierte los campos editados en el documento del ingreso. Sin tipo de comprobante se registra
 * solo el archivo como respaldo; con tipo, los datos que permiten detectar duplicados son obligatorios.
 */
export function purchaseDocument(f: DocumentFields) {
  if (!f.docType) return { document: null, error: '' };
  const { series, number } = normalizeDocumentNumber(f.series, f.number);
  if (!/^\d{11}$/.test(f.supplierRuc) || !series || !number || f.total === null) {
    return { document: null, error: 'Completa RUC (11 dígitos), serie, número y total, o elige «Sin comprobante».' };
  }
  return {
    document: { supplierRuc: f.supplierRuc, docType: f.docType, series, number, total: round2(f.total), igv: round2(f.igv ?? 0), issueDate: validDate(f.issueDate) },
    error: '',
  };
}

export interface Matchable { id: string; label: string; brand: string; sku: string; barcode: string }
export interface Match { variantId: string; by: 'code' | 'name' | null; candidates: string[] }

const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'con', 'para', 'por', 'x', 'und', 'unid', 'unidad', 'unidades', 'u']);
export function tokens(text: string): Set<string> {
  const words = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w)).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
  return new Set(words);
}

/**
 * Propone la variante de una línea: primero por código exacto; si no, por parecido de nombre.
 * Ante empate (por ejemplo, dos tallas) no elige: deja candidatos para que decida la persona.
 */
export function matchLine(line: { description: string; code: string }, items: Matchable[]): Match {
  const code = line.code.trim().toLowerCase();
  if (code) {
    const exact = items.find((i) => i.barcode.toLowerCase() === code || i.sku.toLowerCase() === code);
    if (exact) return { variantId: exact.id, by: 'code', candidates: [] };
  }
  const wanted = tokens(line.description);
  const scored = items.map((i) => {
    const own = tokens(`${i.label} ${i.brand}`);
    const bare = tokens(i.label);
    const shared = (set: Set<string>) => [...set].filter((t) => wanted.has(t)).length;
    const dice = (set: Set<string>) => (wanted.size + set.size ? (2 * shared(set)) / (wanted.size + set.size) : 0);
    return { id: i.id, score: Math.max(dice(own), dice(bare)) };
  }).filter((s) => s.score >= 0.3).sort((a, b) => b.score - a.score);
  const [first, second] = scored;
  const sure = first && first.score >= 0.6 && (!second || first.score - second.score >= 0.08);
  return { variantId: sure ? first.id : '', by: sure ? 'name' : null, candidates: scored.slice(0, 5).map((s) => s.id) };
}
