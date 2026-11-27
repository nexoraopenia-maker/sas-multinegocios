import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import OpenAI from 'openai';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spentSince } from '@/server/ai/budget';
import { scanPurchase, SCAN_RETRY_MESSAGE, SCAN_UNREADABLE_MESSAGE, type VisionClient } from '@/server/ai/purchase-scan';
import { routes } from '@/server/api/routes';
import { authenticate } from '@/server/auth';
import { disconnect, withTenant } from '@/server/db';
import { checkPurchase, purchaseFile } from '@/server/domain/purchases';
import { createBackup, getBackup, saveModelPrice, updateFeatures } from '@/server/platform';
import { stockAgentModel, scanModel } from '@/shared/ai';
import { parseFeatures } from '@/shared/features';
import type { Extraction } from '@/shared/purchase';
import { makeBusiness, makeProduct, makeUser, run, stockOf, must, type Business } from './helpers';

const MODEL = 'modelo-vision-prueba';
/** Cabecera JPEG válida más contenido único, para que cada archivo tenga otra huella. */
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(randomUUID())]);

const extraction = (number: string, over: Partial<Extraction> = {}): Extraction => ({
  isPurchaseDocument: true, docType: 'factura', supplierRuc: '20123456789', supplierName: 'Proveedor SAC', series: 'f001', number, issueDate: '2026-11-20', currency: 'PEN', total: 100, igv: 15.25,
  lines: [{ description: 'Polo azul M', code: 'ABC', quantity: 5, unitCost: 20, lineTotal: 100, lotCode: '', expiresAt: '' }], ...over,
});

function fake(output: Extraction | string, options: { status?: string; fail?: Error; inputTokens?: number } = {}) {
  const calls: OpenAI.Responses.ResponseCreateParamsNonStreaming[] = [];
  const client: VisionClient = {
    countTokens: async () => ({ input_tokens: options.inputTokens ?? 2000 }),
    create: async (params) => {
      calls.push(params);
      if (options.fail) throw options.fail;
      return {
        status: options.status ?? 'completed', output_text: typeof output === 'string' ? output : JSON.stringify(output),
        usage: { input_tokens: 2000, output_tokens: 400 },
      } as unknown as OpenAI.Responses.Response;
    },
  };
  return { client, calls };
}

describe('escaneo de comprobantes', () => {
  let a: Business, other: Business, variant: string;
  const ctxOf = async (b: Business) => (await authenticate(b.adminAuth.token)).ctx!;
  const features = (b: Business, over: object) => updateFeatures(b.root, b.tenantId, parseFeatures({ aiAgent: true, aiLimitValue: 1, ...over }));
  const scan = async (client: VisionClient, data = jpeg()) => scanPurchase(await ctxOf(a), { branchId: a.main, data, fileName: 'factura.jpg' }, client);
  const spent = () => spentSince(a.tenantId, new Date(0));
  const stockIn = (scanId: string, number: string, over: object = {}) => ({
    branchId: a.main, scanId, reason: `Compra F001-${number}`,
    document: { supplierRuc: '20123456789', docType: '01', series: 'F001', number, total: 100, igv: 15.25, issueDate: '2026-11-20' },
    items: [{ variantId: variant, quantity: 5, unitCost: 20 }], ...over,
  });

  beforeAll(async () => {
    a = await makeBusiness();
    other = await makeBusiness();
    variant = await makeProduct(a, { stock: 10 });
    await features(a, {});
    await features(other, {});
    await saveModelPrice(a.root, { model: MODEL, inputPerMTok: 1, outputPerMTok: 4 });
  });
  beforeEach(() => { process.env.OPENAI_MODEL = MODEL; });
  afterAll(async () => { delete process.env.OPENAI_MODEL; await disconnect(); });

  it('separa los modelos de cada proveedor', () => {
    expect(stockAgentModel({ AI_MODEL: 'gpt-x' })).toBe('claude-haiku-5-5');
    expect(stockAgentModel({ AI_MODEL: 'claude-sonnet-5-5' })).toBe('claude-sonnet-5-5');
    expect(scanModel({ AI_MODEL: 'gpt-x' })).toBe('gpt-x');
    expect(scanModel({ AI_MODEL: 'claude-haiku-5-5' })).toBeNull();
    expect(scanModel({ AI_MODEL: 'claude-haiku-5-5', OPENAI_MODEL: 'gpt-y' })).toBe('gpt-y');
  });

  it('devuelve un borrador, registra el consumo y no toca el inventario', async () => {
    const before = await spent();
    const model = fake(extraction('000101'));
    const data = jpeg();
    const r = await scan(model.client, data);
    expect(r).toMatchObject({ status: 'DRAFT', reused: false, duplicate: null, draft: { docType: '01', series: 'F001', number: '101', total: 100 } });
    expect(model.calls[0]).toMatchObject({ model: MODEL, store: false });
    expect((await spent()).usd - before.usd).toBeCloseTo((2000 * 1 + 400 * 4) / 1e6, 8);
    expect(await stockOf(a.tenantId, a.main, variant)).toBe(10);

    // El mismo archivo no vuelve a consumir.
    const again = fake(extraction('999'));
    expect(await scan(again.client, data)).toMatchObject({ scanId: r.scanId, reused: true });
    expect(again.calls).toHaveLength(0);
    expect((await purchaseFile(await ctxOf(a), r.scanId)).data.equals(data)).toBe(true);
  });

  it('envía los PDF como archivo y rechaza formatos, tamaños y páginas no admitidos', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const model = fake(extraction('102'));
    await scan(model.client, Buffer.from(await pdf.save()));
    expect(JSON.stringify(model.calls[0].input)).toContain('"type":"input_file"');
    for (let i = 0; i < 11; i++) pdf.addPage();
    const none = fake(extraction('1'));
    await expect(scan(none.client, Buffer.from(await pdf.save()))).rejects.toThrow('páginas');
    await expect(scan(none.client, Buffer.from('<html>hola</html>'))).rejects.toThrow('Formato no admitido');
    await expect(scan(none.client, Buffer.concat([jpeg(), Buffer.alloc(4_000_001)]))).rejects.toThrow('4 MB');
    expect(none.calls).toHaveLength(0);
  });

  it('confirma el ingreso en el kárdex una sola vez y enlaza el respaldo', async () => {
    const r = await scan(fake(extraction('200')).client);
    const before = await stockOf(a.tenantId, a.main, variant);
    const applied = await must(a.admin, 'dev', 'stock.in', stockIn(r.scanId, '200'));
    expect(await stockOf(a.tenantId, a.main, variant)).toBe(before + 5);
    const row = await withTenant(a.tenantId, (tx) => tx.purchaseScan.findFirstOrThrow({ where: { id: r.scanId } }));
    expect(row).toMatchObject({ status: 'CONFIRMED', operationId: applied.id });
    expect(row.purchaseDocumentId).toBeTruthy();
    expect(await withTenant(a.tenantId, (tx) => tx.stockMovement.count({ where: { refId: applied.id } }))).toBe(1);

    const reused = await run(a.admin, 'dev', 'stock.in', stockIn(r.scanId, '201'));
    expect(reused).toMatchObject({ status: 'REJECTED', error: expect.stringContaining('ya se registró') });

    // Otro archivo del mismo comprobante se detecta y se rechaza.
    const copy = await scan(fake(extraction('0200')).client);
    expect(copy.duplicate).toMatchObject({ total: 100 });
    expect((await checkPurchase(a.admin, { supplierRuc: '20123456789', docType: '01', series: 'f001', number: '00200' })).duplicate).toBeTruthy();
    expect((await run(a.admin, 'dev', 'stock.in', stockIn(copy.scanId, '200'))).status).toBe('REJECTED');
    expect(await stockOf(a.tenantId, a.main, variant)).toBe(before + 5);
    // El rechazo no consume el respaldo.
    expect((await withTenant(a.tenantId, (tx) => tx.purchaseScan.findFirstOrThrow({ where: { id: copy.scanId } }))).status).toBe('DRAFT');
  });

  it('el archivo de respaldo no se puede alterar ni borrar y entra en el respaldo de la cuenta', async () => {
    await scan(fake(extraction('300')).client);
    await expect(withTenant(a.tenantId, (tx) => tx.purchaseScan.updateMany({ data: { data: new Uint8Array([1]) } }))).rejects.toThrow();
    await expect(withTenant(a.tenantId, (tx) => tx.purchaseScan.deleteMany())).rejects.toThrow();
    const { id } = await createBackup(a.root, a.tenantId);
    const json = JSON.parse(gunzipSync((await getBackup(a.root, id)).data).toString());
    expect(typeof json.tables.purchaseScan[0].data).toBe('string');
  });

  it('aísla negocios y exige permisos y sucursal', async () => {
    const r = await scan(fake(extraction('400')).client);
    await expect(purchaseFile(await ctxOf(other), r.scanId)).rejects.toThrow('no encontrado');
    expect(await withTenant(other.tenantId, (tx) => tx.purchaseScan.findMany())).toEqual([]);
    const foreign = await run(other.admin, 'dev', 'stock.in', { branchId: other.main, scanId: r.scanId, items: [{ variantId: await makeProduct(other), quantity: 1 }] });
    expect(foreign.status).toBe('REJECTED');
    const seller = (await makeUser(a.admin, 'SELLER', [a.main])).ctx!;
    await expect(scanPurchase(seller, { branchId: a.main, data: jpeg(), fileName: 'x.jpg' }, fake(extraction('1')).client)).rejects.toThrow('permiso');
    await expect(purchaseFile(seller, r.scanId)).rejects.toThrow('permiso');
    const elsewhere = (await makeUser(a.admin, 'SUPERVISOR', [a.second])).ctx!;
    await expect(purchaseFile(elsewhere, r.scanId)).rejects.toThrow('sucursal');
    await expect(scanPurchase(elsewhere, { branchId: a.main, data: jpeg(), fileName: 'x.jpg' }, fake(extraction('1')).client)).rejects.toThrow('sucursal');
    expect(routes.filter((x) => x.path.startsWith('purchases')).every((x) => !x.access)).toBe(true);
  });

  it('respeta la activación, el modelo con precio y el límite de consumo', async () => {
    const model = fake(extraction('500'));
    await features(a, { aiAgent: false });
    await expect(scan(model.client)).rejects.toThrow('no está habilitada');
    await features(a, { aiLimitValue: 0.000001 });
    await expect(scan(model.client)).rejects.toThrow('límite de consumo');
    await features(a, {});
    process.env.OPENAI_MODEL = 'sin-precio';
    await expect(scan(model.client)).rejects.toThrow('no tiene precio');
    delete process.env.OPENAI_MODEL;
    await expect(scan(model.client)).rejects.toThrow('Falta el modelo');
    expect(model.calls).toHaveLength(0);
  });

  it('ante fallos hace un solo intento y no guarda borradores', async () => {
    const count = () => withTenant(a.tenantId, (tx) => tx.purchaseScan.count());
    const drafts = await count();
    const start = (await spent()).usd;
    const down = fake(extraction('1'), { fail: new OpenAI.APIError(500, undefined, 'caído', new Headers()) });
    await expect(scan(down.client)).rejects.toThrow(SCAN_RETRY_MESSAGE);
    expect(down.calls).toHaveLength(1);
    expect((await spent()).usd).toBeCloseTo(start, 8);

    await expect(scan(fake('no es json').client)).rejects.toThrow(SCAN_UNREADABLE_MESSAGE);
    await expect(scan(fake(extraction('1'), { status: 'incomplete' }).client)).rejects.toThrow('incompleta');
    await expect(scan(fake(extraction('1', { isPurchaseDocument: false })).client)).rejects.toThrow('No se reconoció');
    const huge = fake(extraction('1'), { inputTokens: 500_000 });
    await expect(scan(huge.client)).rejects.toThrow('demasiado extenso');
    expect(huge.calls).toHaveLength(0);

    // Corte de red: no se sabe si se facturó, así que se conserva la reserva.
    const beforeCut = (await spent()).usd;
    await expect(scan(fake(extraction('1'), { fail: new OpenAI.APIConnectionError({ message: 'sin red' }) }).client)).rejects.toThrow(SCAN_RETRY_MESSAGE);
    expect((await spent()).usd).toBeGreaterThan(beforeCut);
    expect(await count()).toBe(drafts);
  });
});
