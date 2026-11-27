import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import type { AttributeDef } from '@/shared/attributes';
import { need, needBranch, type Ctx } from '../context';
import { lock, withTenant } from '../db';
import { AppError } from '../errors';
import { saveProductTx, variantInput, productInput } from './catalog';
import { stockIn } from './inventory-ops';

export const IMPORT_COLUMNS = ['nombre', 'categoria', 'marca', 'sku', 'codigo_barras', 'precio', 'costo', 'stock_minimo', 'stock', 'lote', 'vence'] as const;
const MAX_ROWS = 2000;

export async function importTemplate(ctx: Ctx) {
  need(ctx, 'catalog.manage');
  const categories = await withTenant(ctx.tenantId, (tx) => tx.category.findMany({ where: { tenantId: ctx.tenantId } }));
  const attributeKeys = [...new Set(categories.flatMap((c) => (c.attributes as unknown as AttributeDef[]).map((a) => a.key)))];
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Productos');
  const headers = [...IMPORT_COLUMNS, ...attributeKeys.map((k) => `attr:${k}`)];
  sheet.addRow(headers).font = { bold: true };
  sheet.columns.forEach((c) => (c.width = 18));
  const help = wb.addWorksheet('Instrucciones');
  [
    ['Obligatorios: nombre, categoria, precio.'],
    ['Filas con el mismo nombre y categoría forman un producto con variantes.'],
    ['Si sku o codigo_barras están vacíos, el sistema los genera.'],
    ['Si sku o codigo_barras ya existen, la fila suma stock a ese producto.'],
    ['vence: formato AAAA-MM-DD (obligatorio con stock en categorías con vencimiento).'],
    [`Categorías: ${categories.map((c) => c.name).join(', ')}`],
  ].forEach((r) => help.addRow(r));
  help.getColumn(1).width = 100;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const first = clean.split(/\r?\n/, 1)[0];
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function readRows(file: Buffer, filename: string): Promise<string[][]> {
  if (/\.csv$/i.test(filename)) return parseCsv(file.toString('utf8'));
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(file as unknown as ArrayBuffer);
  } catch {
    throw new AppError('No se pudo leer el archivo. Usa la plantilla .xlsx o un .csv');
  }
  const sheet = wb.worksheets[0];
  const rows: string[][] = [];
  sheet?.eachRow({ includeEmpty: false }, (r) => {
    const cells: string[] = [];
    for (let c = 1; c <= sheet.columnCount; c++) {
      const value = r.getCell(c).value;
      cells.push(value instanceof Date ? value.toISOString().slice(0, 10) : r.getCell(c).text.trim());
    }
    rows.push(cells);
  });
  return rows;
}

export interface ImportReport { ok: boolean; rows: number; newProducts: number; newVariants: number; stockLines: number; errors: { row: number; message: string }[] }

class Rollback extends Error {}

/** Valida e importa en una sola transacción: o entran todas las filas o ninguna. */
export async function importProducts(ctx: Ctx, input: { file: Buffer; filename: string; branchId: string; dryRun: boolean }): Promise<ImportReport> {
  need(ctx, 'catalog.manage');
  need(ctx, 'stock.in');
  needBranch(ctx, input.branchId);
  const raw = await readRows(input.file, input.filename);
  const header = (raw.shift() ?? []).map((h) => h.trim().toLowerCase());
  for (const col of ['nombre', 'categoria', 'precio']) if (!header.includes(col)) throw new AppError(`Falta la columna "${col}"`);
  const rows = raw.map((cells, i) => ({ line: i + 2, get: (k: string) => (cells[header.indexOf(k)] ?? '').trim(), empty: cells.every((c) => !c.trim()) })).filter((r) => !r.empty);
  if (!rows.length) throw new AppError('El archivo no tiene filas');
  if (rows.length > MAX_ROWS) throw new AppError(`Máximo ${MAX_ROWS} filas por archivo`);

  const report: ImportReport = { ok: false, rows: rows.length, newProducts: 0, newVariants: 0, stockLines: 0, errors: [] };
  const num = (text: string, field: string) => {
    if (!text) return undefined;
    const n = Number(text.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) throw new AppError(`${field} no es un número válido: ${text}`);
    return n;
  };

  try {
    await withTenant(ctx.tenantId, async (tx) => {
      await lock(tx, `catalog:${ctx.tenantId}`);
      const categories = await tx.category.findMany({ where: { tenantId: ctx.tenantId } });
      const stockItems: { variantId: string; quantity: number; unitCost?: number; lotCode?: string; expiresAt?: string }[] = [];
      const groups = new Map<string, { category: (typeof categories)[number]; rows: typeof rows }>();

      for (const row of rows) {
        try {
          const category = categories.find((c) => c.name.toLowerCase() === row.get('categoria').toLowerCase());
          if (!row.get('nombre')) throw new AppError('Falta el nombre');
          if (!category) throw new AppError(`La categoría "${row.get('categoria')}" no existe`);
          const expiresAt = row.get('vence');
          if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) throw new AppError('vence debe tener formato AAAA-MM-DD');
          const quantity = num(row.get('stock'), 'stock');
          const or = [...(row.get('sku') ? [{ sku: row.get('sku') }] : []), ...(row.get('codigo_barras') ? [{ barcode: row.get('codigo_barras') }] : [])];
          const existing = or.length ? await tx.variant.findFirst({ where: { tenantId: ctx.tenantId, OR: or }, include: { product: true } }) : null;
          if (existing) {
            if (!quantity) throw new AppError('El código ya existe y la fila no trae stock que sumar');
            if (existing.product.tracksExpiry && !expiresAt) throw new AppError('Este producto requiere fecha de vencimiento');
            stockItems.push({ variantId: existing.id, quantity, unitCost: num(row.get('costo'), 'costo'), lotCode: row.get('lote') || undefined, expiresAt: expiresAt || undefined });
            continue;
          }
          const key = `${category.id}|${row.get('nombre').toLowerCase()}`;
          if (!groups.has(key)) groups.set(key, { category, rows: [] });
          groups.get(key)!.rows.push(row);
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          report.errors.push({ row: row.line, message: e.message });
        }
      }

      for (const { category, rows: group } of groups.values()) {
        const defs = category.attributes as unknown as AttributeDef[];
        const attrs = (row: (typeof rows)[number], perVariant: boolean) =>
          Object.fromEntries(defs.filter((d) => d.perVariant === perVariant).map((d) => [d.key, row.get(`attr:${d.key}`)]).filter(([, v]) => v));
        try {
          const name = group[0].get('nombre');
          if (await tx.product.findFirst({ where: { tenantId: ctx.tenantId, categoryId: category.id, name: { equals: name, mode: 'insensitive' } } })) {
            throw new AppError(`El producto "${name}" ya existe: usa su sku o código de barras para sumar stock`);
          }
          const parsed = productInput.safeParse({
            categoryId: category.id, name, brand: group[0].get('marca'), tracksExpiry: category.tracksExpiry,
            attributes: attrs(group[0], false), branchId: input.branchId,
            variants: group.map((row) => {
              const price = num(row.get('precio'), 'precio');
              if (price === undefined) throw new AppError(`Fila ${row.line}: falta el precio`);
              return variantInput.parse({
                sku: row.get('sku'), barcode: row.get('codigo_barras'), attributes: attrs(row, true), price,
                cost: num(row.get('costo'), 'costo'), minStock: num(row.get('stock_minimo'), 'stock_minimo') ?? 0,
                initialStock: num(row.get('stock'), 'stock'), lotCode: row.get('lote') || undefined, expiresAt: row.get('vence') || undefined,
              });
            }),
          });
          if (!parsed.success) throw new AppError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
          // Los errores de validación ocurren antes de escribir en la base, así que se pueden acumular.
          await saveProductTx(tx, ctx, parsed.data);
          report.newProducts++;
          report.newVariants += group.length;
          report.stockLines += parsed.data.variants.filter((v) => v.initialStock).length;
        } catch (e) {
          if (e instanceof AppError) report.errors.push({ row: group[0].line, message: e.message });
          else if (e && typeof e === 'object' && 'issues' in e) report.errors.push({ row: group[0].line, message: 'Valores fuera de rango (revisa precio, costo y stock; máximo 2 decimales en importes)' });
          else throw e;
        }
      }

      if (stockItems.length && !report.errors.length) {
        const id = randomUUID();
        await stockIn(tx, ctx, { branchId: input.branchId, reason: 'Ingreso masivo', initial: false, items: stockItems }, { time: new Date(), deviceKey: 'import', opId: id });
      }
      report.stockLines += stockItems.length;
      if (report.errors.length || input.dryRun) throw new Rollback();
    }, { timeout: 120_000 });
    report.ok = true;
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    report.ok = report.errors.length === 0;
  }
  report.errors.sort((a, b) => a.row - b.row);
  return report;
}
