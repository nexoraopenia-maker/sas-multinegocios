import { describe, expect, it } from 'vitest';
import { computeAlerts } from '@/shared/alerts';
import { ean13CheckDigit, internalBarcode, isEan13 } from '@/shared/codes';
import { saleTotals } from '@/shared/money';
import { parseSunatQr } from '@/shared/sunat-qr';
import { allocateFefo } from '@/shared/stock';
import { parseCsv } from '@/server/domain/import';

describe('reglas compartidas', () => {
  it('alertas: vencidos, por vencer y bajo stock respetan sus interruptores', () => {
    const input = {
      today: '2026-11-26', branchIds: ['b'],
      variants: [
        { id: 'choco', label: 'Chocolate', sku: 'C', minStock: 10, tracksExpiry: true, active: true },
        { id: 'anillo', label: 'Anillo', sku: 'A', minStock: 0, tracksExpiry: false, active: true },
      ],
      lots: [{ id: 'v', variantId: 'choco', code: 'V', expiresAt: '2026-11-01' }, { id: 'p', variantId: 'choco', code: 'P', expiresAt: '2026-12-10' }, { id: 'x', variantId: 'anillo', code: 'X', expiresAt: '2020-01-01' }],
      balances: [
        { branchId: 'b', variantId: 'choco', lotId: 'v', quantity: 2 }, { branchId: 'b', variantId: 'choco', lotId: 'p', quantity: 3 },
        { branchId: 'b', variantId: 'anillo', lotId: 'x', quantity: 1 }, { branchId: 'otra', variantId: 'choco', lotId: 'v', quantity: 9 },
      ],
      switches: { expired: true, expiring: true, lowStock: true, daysAhead: 30 },
    };
    const r = computeAlerts(input);
    expect(r.expired.map((a) => a.lotCode)).toEqual(['V']);
    expect(r.expiring.map((a) => a.lotCode)).toEqual(['P']);
    expect(r.lowStock).toMatchObject([{ variantId: 'choco', quantity: 5 }]);
    const off = computeAlerts({ ...input, switches: { expired: false, expiring: false, lowStock: false, daysAhead: 30 } });
    expect([off.expired, off.expiring, off.lowStock].flat()).toEqual([]);
  });

  it('FEFO deja lo vencido al final y marca el faltante', () => {
    expect(allocateFefo([
      { lotId: 'viejo', expiresAt: '2026-01-01', quantity: 5 }, { lotId: 'lejos', expiresAt: '2027-01-01', quantity: 5 },
      { lotId: 'cerca', expiresAt: '2026-12-01', quantity: 2 },
    ], 13, '2026-11-26')).toEqual([{ lotId: 'cerca', quantity: 2 }, { lotId: 'lejos', quantity: 5 }, { lotId: 'viejo', quantity: 5 }, { lotId: null, quantity: 1 }]);
  });

  it('códigos EAN-13', () => {
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(isEan13(internalBarcode(42))).toBe(true);
  });

  it('totales sin errores de redondeo', () => {
    expect(saleTotals([{ quantity: 3, unitPrice: 0.1, discount: 0 }, { quantity: 1, unitPrice: 0.2, discount: 0.05 }])).toMatchObject({ subtotal: 0.5, discount: 0.05, total: 0.45 });
  });

  it('lee el QR de un comprobante peruano', () => {
    expect(parseSunatQr('20123456789|01|F001|00000123|18.00|118.00|26/11/2026|6|20987654321|abc')).toEqual({ supplierRuc: '20123456789', docType: '01', series: 'F001', number: '123', igv: 18, total: 118, issueDate: '2026-11-26' });
    expect(parseSunatQr('https://ejemplo.com')).toBeNull();
  });

  it('CSV con comillas y separador ;', () => {
    expect(parseCsv('a;b\n"x;y";"di ""hola"""\n')).toEqual([['a', 'b'], ['x;y', 'di "hola"']]);
  });
});
