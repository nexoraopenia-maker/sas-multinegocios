import { describe, expect, it } from 'vitest';
import { availableFilters, filterVariants } from '@/shared/inventory-filters';
import { labelsHref, parseLabelsParam } from '@/shared/labels';
import { matchLine, normalizeDocumentNumber, purchaseDocument, sniffMime, toDraft, validDate, type Extraction } from '@/shared/purchase';
import type { Snapshot } from '@/shared/snapshot';
import { parseSunatQr } from '@/shared/sunat-qr';

const item = (id: string, label: string, sku = id, barcode = `${id}-bar`) => ({ id, label, brand: '', sku, barcode });
const catalog = [item('s', 'Polo básico · S · Negro'), item('m', 'Polo básico · M · Negro'), item('c', 'Chocolate bitter · Tableta 100 g', 'CHO-1', '7750001')];

describe('emparejamiento de líneas', () => {
  it('prioriza el código exacto', () => {
    expect(matchLine({ description: 'otra cosa', code: '7750001' }, catalog)).toMatchObject({ variantId: 'c', by: 'code' });
    expect(matchLine({ description: '', code: 'cho-1' }, catalog).variantId).toBe('c');
  });
  it('sugiere por nombre cuando hay un único candidato claro', () => {
    expect(matchLine({ description: 'CHOCOLATES BITTER TABLETA 100G', code: '' }, catalog)).toMatchObject({ variantId: 'c', by: 'name' });
    expect(matchLine({ description: 'Polo básico negro talla M', code: '' }, catalog).variantId).toBe('m');
  });
  it('no elige ante un empate ni sin parecido', () => {
    const tie = matchLine({ description: 'Polo básico negro', code: '' }, catalog);
    expect(tie.variantId).toBe('');
    expect(tie.candidates.sort()).toEqual(['m', 's']);
    expect(matchLine({ description: 'Taladro percutor', code: '' }, catalog)).toEqual({ variantId: '', by: null, candidates: [] });
  });
});

describe('borrador del comprobante', () => {
  const raw: Extraction = {
    isPurchaseDocument: true, docType: 'boleta', supplierRuc: '123', supplierName: '  Proveedor \n SAC ', series: 'B001-0007', number: '', issueDate: '2026-02-30', currency: 'usd', total: -1, igv: null,
    lines: [
      { description: 'Agua', code: '', quantity: 3, unitCost: null, lineTotal: 10, lotCode: '', expiresAt: '2027-01-31' },
      { description: 'Ilegible', code: '', quantity: -2, unitCost: 1, lineTotal: null, lotCode: '', expiresAt: '31/01/2027' },
      { description: '', code: '', quantity: 1, unitCost: 1, lineTotal: 1, lotCode: '', expiresAt: '' },
    ],
  };
  it('limpia datos no válidos y avisa', () => {
    const d = toDraft(raw);
    expect(d).toMatchObject({ docType: '03', supplierRuc: '', supplierName: 'Proveedor SAC', series: 'B001', number: '7', issueDate: '', currency: 'USD', total: null });
    expect(d.lines).toHaveLength(2);
    expect(d.lines[0]).toMatchObject({ quantity: 3, unitCost: 3.33, expiresAt: '2027-01-31' });
    expect(d.lines[1]).toMatchObject({ quantity: 0, expiresAt: '' });
    expect(d.warnings.join(' ')).toMatch(/RUC.*USD.*cantidad/);
    expect(validDate('2028-02-29')).toBe('2028-02-29');
  });
  it('numera igual que el QR de SUNAT, para detectar duplicados', () => {
    const qr = parseSunatQr('20123456789|01|F001|00000123|15.25|100.00|2026-11-20|6|1|')!;
    expect(normalizeDocumentNumber('f001', '000123')).toEqual({ series: qr.series, number: qr.number });
  });
  it('exige datos completos del comprobante o ninguno', () => {
    const base = { docType: '01', supplierRuc: '20123456789', series: 'F001', number: '5', issueDate: '', total: 10, igv: null };
    expect(purchaseDocument(base).document).toMatchObject({ number: '5', igv: 0 });
    expect(purchaseDocument({ ...base, supplierRuc: '1' }).error).toContain('RUC');
    expect(purchaseDocument({ ...base, total: null }).error).toBeTruthy();
    expect(purchaseDocument({ ...base, docType: '', supplierRuc: '' })).toEqual({ document: null, error: '' });
  });
  it('reconoce el tipo de archivo por su contenido', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(sniffMime(Buffer.from('RIFF0000WEBP'))).toBe('image/webp');
    expect(sniffMime(Buffer.from('GIF89a'))).toBeNull();
  });
});

describe('etiquetas tras un ingreso', () => {
  it('suma cantidades por variante, redondea hacia arriba y limita', () => {
    const href = labelsHref([{ variantId: 'a', quantity: 2 }, { variantId: 'a', quantity: 1.5 }, { variantId: 'b', quantity: 9000 }]);
    expect(href).toBe('/app/etiquetas?v=a:4,b:500');
    expect(parseLabelsParam(href.split('v=')[1])).toEqual({ a: 4, b: 500 });
    expect(parseLabelsParam('x,y:-1,z:abc,w:3')).toEqual({ w: 3 });
  });
});

describe('filtros rápidos de inventario', () => {
  const view = {
    products: [{ id: 'p', name: 'Yogur', tracksExpiry: true, active: true }],
    variants: [
      { id: 'a', productId: 'p', sku: 'a', attributes: {}, minStock: 5, active: true },
      { id: 'b', productId: 'p', sku: 'b', attributes: {}, minStock: 0, active: true },
    ],
    lots: [{ id: 'l1', variantId: 'a', code: 'L1', expiresAt: '2026-01-01' }],
    balances: [{ branchId: 'x', variantId: 'a', lotId: 'l1', quantity: 2 }, { branchId: 'otra', variantId: 'b', lotId: null, quantity: 9 }],
  } as unknown as Snapshot;
  const on = { expired: true, expiring: true, lowStock: true, daysAhead: 30 };
  const of = (f: Parameters<typeof filterVariants>[2]) => [...filterVariants(view, 'x', f, on, '2026-06-01')!];

  it('filtra por la sucursal activa', () => {
    expect(filterVariants(view, 'x', 'all', on)).toBeNull();
    expect(of('in')).toEqual(['a']);
    expect(of('out')).toEqual(['b']);
    expect(of('low')).toEqual(['a']);
    expect(of('expired')).toEqual(['a']);
    expect(of('expiring')).toEqual([]);
  });
  it('oculta los filtros de alertas desactivadas o sin permiso', () => {
    expect(availableFilters({ ...on, expired: false }, true)).toEqual(['all', 'in', 'out', 'low', 'expiring']);
    expect(availableFilters(on, false)).toEqual(['all', 'in', 'out']);
  });
});
