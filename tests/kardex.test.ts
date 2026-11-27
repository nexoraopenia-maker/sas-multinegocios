import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate } from '@/server/auth';
import { disconnect, withTenant } from '@/server/db';
import { saveSunat } from '@/server/domain/admin';
import { importProducts, importTemplate } from '@/server/domain/import';
import { cashSessions, kardex, saleDetail } from '@/server/domain/queries';
import { toPdf, toXlsx } from '@/server/reports/export';
import { buildReport } from '@/server/reports/reports';
import { updateFeatures } from '@/server/platform';
import { parseFeatures } from '@/shared/features';
import { REPORTS, type ReportType } from '@/shared/reports';
import { isEan13 } from '@/shared/codes';
import { addDays, todayISO } from '@/shared/stock';
import { makeBusiness, makeProduct, makeRegister, makeUser, must, run, stockOf, type Business } from './helpers';

describe('kárdex, inventario, caja y traslados', () => {
  let b: Business;
  beforeAll(async () => { b = await makeBusiness(); });
  afterAll(disconnect);

  const lotsOf = (variantId: string) => withTenant(b.tenantId, async (tx) => {
    const lots = await tx.lot.findMany({ where: { variantId }, orderBy: { expiresAt: 'asc' } });
    const balances = await tx.stockBalance.findMany({ where: { variantId, branchId: b.main } });
    return lots.map((l) => ({ code: l.code, quantity: Number(balances.find((x) => x.lotKey === l.id)?.quantity ?? 0) }));
  });

  it('genera SKU y código de barras EAN-13 únicos', async () => {
    const ids = [await makeProduct(b), await makeProduct(b)];
    const rows = await withTenant(b.tenantId, (tx) => tx.variant.findMany({ where: { id: { in: ids } } }));
    expect(rows.every((v) => isEan13(v.barcode) && v.sku.startsWith('ROP-'))).toBe(true);
    expect(new Set(rows.map((v) => v.barcode)).size).toBe(2);
  });

  it('exige vencimiento solo a quien lo controla y vende primero el lote que vence antes (FEFO)', async () => {
    const shirt = await makeProduct(b);
    const choco = await makeProduct(b, { categoryId: b.food, tracksExpiry: true, stock: 5, price: 10, expiresAt: addDays(todayISO(), 60) });
    const register = await makeRegister(b.admin, b.main);
    expect((await run(b.admin, register.deviceKey, 'stock.in', { branchId: b.main, items: [{ variantId: choco, quantity: 1 }] })).error).toContain('vencimiento');
    await must(b.admin, register.deviceKey, 'stock.in', { branchId: b.main, items: [{ variantId: shirt, quantity: 1 }] });
    await must(b.admin, register.deviceKey, 'stock.in', { branchId: b.main, items: [{ variantId: choco, quantity: 3, expiresAt: addDays(todayISO(), 10), lotCode: 'PRONTO' }] });
    const sale = register.sale(choco, 4, 10);
    await must(b.admin, register.deviceKey, 'sale.create', sale);
    expect(await lotsOf(choco)).toEqual([{ code: 'PRONTO', quantity: 0 }, { code: `V-${addDays(todayISO(), 60)}`, quantity: 4 }]);
    // Una devolución reingresa al lote de origen.
    const detail = await saleDetail(b.admin, sale.saleId);
    await must(b.admin, register.deviceKey, 'sale.return', { returnId: randomUUID(), saleId: sale.saleId, reason: 'cambio', refundMethod: 'VOUCHER', items: [{ saleItemId: detail.items[0].id, quantity: 4 }] });
    expect((await lotsOf(choco)).map((l) => l.quantity)).toEqual([3, 5]);
  });

  it('el saldo siempre es la suma del kárdex', async () => {
    const v = await makeProduct(b, { stock: 20 });
    const register = await makeRegister(b.admin, b.main);
    await must(b.admin, register.deviceKey, 'sale.create', register.sale(v, 3));
    const adjustmentId = randomUUID();
    await must(b.admin, register.deviceKey, 'adjustment.request', { adjustmentId, branchId: b.main, kind: 'WASTE', reason: 'Dañado', items: [{ variantId: v, delta: -2 }] });
    expect(await stockOf(b.tenantId, b.main, v)).toBe(17); // pendiente: aún no descuenta
    await must(b.admin, register.deviceKey, 'adjustment.review', { adjustmentId, approve: true });
    expect((await run(b.admin, register.deviceKey, 'adjustment.review', { adjustmentId, approve: true })).error).toContain('ya fue revisado');
    const moves = await kardex(b.admin, { variantId: v, branchId: b.main });
    expect(moves.reduce((s, m) => s + m.quantity, 0)).toBe(15);
    expect(await stockOf(b.tenantId, b.main, v)).toBe(15);
    expect(moves.every((m) => m.user && m.reason)).toBe(true);
  });

  it('el conteo físico concilia contra el stock del momento del conteo', async () => {
    const v = await makeProduct(b, { stock: 10 });
    const register = await makeRegister(b.admin, b.main);
    const adjustmentId = randomUUID();
    await must(b.admin, register.deviceKey, 'adjustment.request', { adjustmentId, branchId: b.main, kind: 'COUNT', reason: 'Conteo mensual', items: [{ variantId: v, delta: 0, countedQty: 8 }] });
    await new Promise((r) => setTimeout(r, 20));
    await must(b.admin, register.deviceKey, 'sale.create', register.sale(v, 1)); // venta posterior al conteo
    await must(b.admin, register.deviceKey, 'adjustment.review', { adjustmentId, approve: true });
    expect(await stockOf(b.tenantId, b.main, v)).toBe(7);
  });

  it('anular revierte stock y caja, con permiso', async () => {
    const v = await makeProduct(b, { stock: 5 });
    const register = await makeRegister(b.admin, b.main);
    const sale = register.sale(v, 2);
    await must(b.admin, register.deviceKey, 'sale.create', sale);
    await must(b.admin, register.deviceKey, 'sale.void', { saleId: sale.saleId, reason: 'error de cobro', cashSessionId: register.cashSessionId });
    expect(await stockOf(b.tenantId, b.main, v)).toBe(5);
    expect((await run(b.admin, register.deviceKey, 'sale.void', { saleId: sale.saleId, reason: 'otra vez', cashSessionId: register.cashSessionId })).status).toBe('REJECTED');
    const closed = await must(b.admin, register.deviceKey, 'cash.close', { cashSessionId: register.cashSessionId, counted: { CASH: 90 } });
    expect(closed.result).toMatchObject({ difference: -10, expected: { CASH: 100 } });
    expect((await cashSessions(b.admin, {})).find((s) => s.id === register.cashSessionId)?.difference).toBe(-10);
  });

  it('devoluciones parciales: no exceden lo vendido ni lo cobrado, y el vale se puede usar una vez', async () => {
    const v = await makeProduct(b, { stock: 5, price: 10 });
    const register = await makeRegister(b.admin, b.main);
    const sale = register.sale(v, 3, 10);
    sale.items[0].discount = 1;
    sale.payments[0].amount = 29;
    await must(b.admin, register.deviceKey, 'sale.create', sale);
    const line = (await saleDetail(b.admin, sale.saleId)).items[0].id;
    let total = 0;
    let code = '';
    for (let i = 0; i < 3; i++) {
      const r = await must(b.admin, register.deviceKey, 'sale.return', { returnId: randomUUID(), saleId: sale.saleId, reason: 'cambio de talla', refundMethod: 'VOUCHER', items: [{ saleItemId: line, quantity: 1 }] });
      total += (r.result as { total: number }).total;
      code = (r.result as { voucherCode: string }).voucherCode;
    }
    expect(Math.round(total * 100)).toBe(2900);
    const extra = await run(b.admin, register.deviceKey, 'sale.return', { returnId: randomUUID(), saleId: sale.saleId, reason: 'de más', refundMethod: 'VOUCHER', items: [{ saleItemId: line, quantity: 1 }] });
    expect(extra.status).toBe('REJECTED');
    const balance = await withTenant(b.tenantId, async (tx) => Number((await tx.voucher.findFirstOrThrow({ where: { code } })).balance));
    const pay = () => ({ ...register.sale(v, 1, 10), payments: [{ method: 'VOUCHER', amount: balance, reference: code }, { method: 'CASH', amount: Math.round((10 - balance) * 100) / 100, reference: '' }] });
    expect((await run(b.admin, register.deviceKey, 'sale.create', pay())).status).toBe('APPLIED');
    expect((await run(b.admin, register.deviceKey, 'sale.create', pay())).error).toContain('vale');
  });

  it('traslado: solicitud, aprobación, envío y recepción con diferencia', async () => {
    const v = await makeProduct(b, { stock: 10 });
    const requester = (await makeUser(b.admin, 'SELLER', [b.second], ['transfer.request', 'transfer.operate'])).ctx!;
    const supervisor = (await makeUser(b.admin, 'SUPERVISOR', [b.main])).ctx!;
    const d = randomUUID();
    const transferId = randomUUID();
    await must(requester, d, 'transfer.request', { transferId, fromBranchId: b.main, toBranchId: b.second, items: [{ variantId: v, quantity: 4 }] });
    expect((await run(supervisor, d, 'transfer.ship', { transferId, items: [{ variantId: v, quantity: 4 }] })).status).toBe('REJECTED'); // sin aprobar
    expect((await run(requester, d, 'transfer.review', { transferId, approve: true })).error).toContain('permiso');
    await must(supervisor, d, 'transfer.review', { transferId, approve: true });
    expect((await run(requester, d, 'transfer.ship', { transferId, items: [{ variantId: v, quantity: 4 }] })).error).toContain('sucursal');
    await must(supervisor, d, 'transfer.ship', { transferId, items: [{ variantId: v, quantity: 4 }] });
    expect(await stockOf(b.tenantId, b.main, v)).toBe(6);
    expect(await stockOf(b.tenantId, b.second, v)).toBe(0);
    await must(requester, d, 'transfer.receive', { transferId, items: [{ variantId: v, quantity: 3 }] });
    expect(await stockOf(b.tenantId, b.second, v)).toBe(3);
    const notices = await withTenant(b.tenantId, (tx) => tx.supervisorNotice.findMany({ where: { type: 'TRANSFER_DIFFERENCE' } }));
    expect(notices).toHaveLength(1);
  });

  it('sin multisucursal activada no hay traslados', async () => {
    const other = await makeBusiness();
    await updateFeatures(other.root, other.tenantId, parseFeatures({ multiBranch: false }));
    const ctx = (await authenticate(other.adminAuth.token)).ctx!;
    expect(ctx.branchIds).toHaveLength(1);
    const r = await run(ctx, randomUUID(), 'transfer.request', { transferId: randomUUID(), fromBranchId: other.main, toBranchId: other.second, items: [{ variantId: 'x', quantity: 1 }] });
    expect(r.error).toContain('no está habilitada');
  });

  it('un comprobante de proveedor no se ingresa dos veces', async () => {
    const v = await makeProduct(b, { stock: 0 });
    const payload = { branchId: b.main, document: { supplierRuc: '20123456789', docType: '01', series: 'F001', number: '55', total: 100 }, items: [{ variantId: v, quantity: 5, unitCost: 20 }] };
    expect((await run(b.admin, randomUUID(), 'stock.in', payload)).status).toBe('APPLIED');
    expect((await run(b.admin, randomUUID(), 'stock.in', payload)).error).toContain('ya fue ingresado');
    expect(await stockOf(b.tenantId, b.main, v)).toBe(5);
  });

  it('importación masiva: valida todo antes de escribir', async () => {
    const template = new ExcelJS.Workbook();
    await template.xlsx.load((await importTemplate(b.admin)) as unknown as ArrayBuffer);
    expect(template.worksheets[0].getRow(1).getCell(1).text).toBe('nombre');
    const count = () => withTenant(b.tenantId, (tx) => tx.variant.count());
    const before = await count();
    const header = 'nombre;categoria;precio;costo;stock;vence;attr:talla\n';
    const bad = Buffer.from(`${header}Casaca;Ropa;80;40;3;;M\nGaseosa;Alimentos y bebidas;3;1;10;;\nX;No existe;1;;;;\n`);
    const failed = await importProducts(b.admin, { file: bad, filename: 'a.csv', branchId: b.main, dryRun: false });
    expect(failed.ok).toBe(false);
    expect(failed.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(await count()).toBe(before);
    const good = Buffer.from(`${header}Casaca;Ropa;80;40;3;;M\nCasaca;Ropa;80;40;2;;L\n`);
    expect((await importProducts(b.admin, { file: good, filename: 'a.csv', branchId: b.main, dryRun: true })).ok).toBe(true);
    expect(await count()).toBe(before);
    expect(await importProducts(b.admin, { file: good, filename: 'a.csv', branchId: b.main, dryRun: false })).toMatchObject({ ok: true, newProducts: 1, newVariants: 2 });
    expect(await count()).toBe(before + 2);
  });

  it('todos los reportes se generan y exportan', async () => {
    for (const type of Object.keys(REPORTS) as ReportType[]) {
      const report = await buildReport(b.admin, type, {});
      expect(report.columns.length).toBeGreaterThan(0);
      expect((await toXlsx(report)).length).toBeGreaterThan(1000);
      expect((await toPdf(report)).subarray(0, 4).toString()).toBe('%PDF');
    }
    expect((await buildReport(b.admin, 'sales_period', {})).rows.length).toBeGreaterThan(0);
  });

  it('SUNAT es un adicional: apagado por defecto y los secretos se guardan cifrados', async () => {
    const input = { ruc: '20123456789', solUser: 'USUARIO', solPassword: 'secreto-sol', certificateBase64: 'A'.repeat(200), certificatePassword: 'secreto-cert', environment: 'BETA' as const };
    await expect(saveSunat(b.admin, input)).rejects.toThrow('no está habilitada');
    await updateFeatures(b.root, b.tenantId, parseFeatures({ sunat: true }));
    const ctx = (await authenticate(b.adminAuth.token)).ctx!;
    await saveSunat(ctx, input);
    const row = await withTenant(b.tenantId, (tx) => tx.sunatConfig.findUniqueOrThrow({ where: { tenantId: b.tenantId } }));
    expect(row.solPasswordEnc).not.toContain('secreto');
    const register = await makeRegister(ctx, b.main);
    const v = await makeProduct(b);
    await must(ctx, register.deviceKey, 'sale.create', register.sale(v));
    expect(await withTenant(b.tenantId, (tx) => tx.electronicDocument.count())).toBe(1);
  });
});
