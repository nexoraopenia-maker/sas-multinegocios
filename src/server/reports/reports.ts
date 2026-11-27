import { Prisma } from '@/generated/prisma/client';
import { round2 } from '@/shared/money';
import { REPORTS, type Report, type ReportColumn, type ReportType } from '@/shared/reports';
import { todayISO } from '@/shared/stock';
import { need, type Ctx } from '../context';
import { withTenant, type Tx } from '../db';
import { branchScope, dateRange, userNames, type RangeFilter } from '../domain/queries';

const c = (key: string, label: string, kind: ReportColumn['kind'] = 'text'): ReportColumn => ({ key, label, kind });
type Row = Record<string, string | number>;
interface Args { tx: Tx; ctx: Ctx; branches: string[]; gte: Date; lte: Date }

const number = (rows: Record<string, unknown>[]): Row[] =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? '' : typeof v === 'string' ? v : Number(v)])));

/** Ventas netas por grupo: total vendido menos devoluciones del mismo periodo de venta. */
async function salesBy({ tx, ctx, branches, gte, lte }: Args, group: Prisma.Sql) {
  return number(await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT ${group} AS label, count(*) AS count, sum(s."discount") AS discount, sum(s."total") AS total,
           coalesce(sum(r.returned), 0) AS returned, sum(s."total") - coalesce(sum(r.returned), 0) AS net
    FROM "Sale" s
    LEFT JOIN (SELECT "saleId", sum("total") AS returned FROM "SaleReturn" WHERE "tenantId" = ${ctx.tenantId} GROUP BY "saleId") r ON r."saleId" = s."id"
    WHERE s."tenantId" = ${ctx.tenantId} AND s."status" = 'COMPLETED' AND s."branchId" IN (${Prisma.join(branches)})
      AND s."occurredAt" BETWEEN ${gte} AND ${lte}
    GROUP BY 1 ORDER BY 1`);
}
const salesColumns = (label: string) => [c('label', label), c('count', 'Ventas', 'number'), c('discount', 'Descuentos', 'money'), c('total', 'Total', 'money'), c('returned', 'Devuelto', 'money'), c('net', 'Neto', 'money')];

async function productNames({ tx, ctx }: Args) {
  const variants = await tx.variant.findMany({ where: { tenantId: ctx.tenantId }, include: { product: true } });
  return new Map(variants.map((v) => [v.id, { name: [v.product.name, ...Object.values(v.attributes as object)].join(' · '), sku: v.sku, cost: Number(v.cost), price: Number(v.price), active: v.active }]));
}
const branchNames = async ({ tx, ctx }: Args) => new Map((await tx.branch.findMany({ where: { tenantId: ctx.tenantId } })).map((b) => [b.id, b.name]));

const builders: Record<ReportType, (a: Args) => Promise<{ columns: ReportColumn[]; rows: Row[]; sum?: string[] }>> = {
  async sales_period(a) {
    const rows = await salesBy(a, Prisma.sql`to_char((s."occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Lima', 'YYYY-MM-DD')`);
    return { columns: salesColumns('Fecha'), rows, sum: ['count', 'discount', 'total', 'returned', 'net'] };
  },
  async sales_branch(a) {
    const names = await branchNames(a);
    const rows = await salesBy(a, Prisma.sql`s."branchId"`);
    return { columns: salesColumns('Sucursal'), rows: rows.map((r) => ({ ...r, label: names.get(String(r.label)) ?? r.label })), sum: ['count', 'discount', 'total', 'returned', 'net'] };
  },
  async sales_seller(a) {
    const names = await userNames(a.tx, a.ctx);
    const rows = await salesBy(a, Prisma.sql`s."userId"`);
    return { columns: salesColumns('Vendedor'), rows: rows.map((r) => ({ ...r, label: names.get(String(r.label)) ?? '—' })), sum: ['count', 'discount', 'total', 'returned', 'net'] };
  },
  async sales_product(a) {
    const names = await productNames(a);
    const rows = number(await a.tx.$queryRaw<Record<string, unknown>[]>`
      SELECT i."variantId" AS id, sum(i."quantity" - i."returnedQty") AS quantity,
             sum(i."total" * (i."quantity" - i."returnedQty") / i."quantity") AS total,
             sum(i."unitCost" * (i."quantity" - i."returnedQty")) AS cost
      FROM "SaleItem" i JOIN "Sale" s ON s."id" = i."saleId" AND s."tenantId" = i."tenantId"
      WHERE s."tenantId" = ${a.ctx.tenantId} AND s."status" = 'COMPLETED' AND s."branchId" IN (${Prisma.join(a.branches)})
        AND s."occurredAt" BETWEEN ${a.gte} AND ${a.lte}
      GROUP BY 1 ORDER BY 3 DESC`);
    return {
      columns: [c('product', 'Producto'), c('sku', 'SKU'), c('quantity', 'Cantidad', 'number'), c('total', 'Venta neta', 'money'), c('cost', 'Costo', 'money'), c('margin', 'Margen', 'money')],
      rows: rows.map((r) => ({ product: names.get(String(r.id))?.name ?? '', sku: names.get(String(r.id))?.sku ?? '', quantity: r.quantity, total: round2(Number(r.total)), cost: round2(Number(r.cost)), margin: round2(Number(r.total) - Number(r.cost)) })),
      sum: ['quantity', 'total', 'cost', 'margin'],
    };
  },
  async valuation(a) {
    const names = await productNames(a);
    const branches = await branchNames(a);
    const groups = await a.tx.stockBalance.groupBy({ by: ['branchId', 'variantId'], where: { tenantId: a.ctx.tenantId, branchId: { in: a.branches } }, _sum: { quantity: true } });
    const rows = groups.map((g) => {
      const v = names.get(g.variantId)!;
      const q = Number(g._sum.quantity ?? 0);
      return { branch: branches.get(g.branchId) ?? '', product: v.name, sku: v.sku, quantity: q, cost: v.cost, costValue: round2(Math.max(q, 0) * v.cost), saleValue: round2(Math.max(q, 0) * v.price) };
    }).filter((r) => r.quantity !== 0).sort((x, y) => y.costValue - x.costValue);
    return { columns: [c('branch', 'Sucursal'), c('product', 'Producto'), c('sku', 'SKU'), c('quantity', 'Stock', 'number'), c('cost', 'Costo unit.', 'money'), c('costValue', 'Valor al costo', 'money'), c('saleValue', 'Valor de venta', 'money')], rows, sum: ['quantity', 'costValue', 'saleValue'] };
  },
  async rotation(a) {
    const names = await productNames(a);
    const sold = await a.tx.stockMovement.groupBy({ by: ['variantId'], where: { tenantId: a.ctx.tenantId, branchId: { in: a.branches }, type: { in: ['SALE', 'SALE_VOID', 'RETURN'] }, occurredAt: { gte: a.gte, lte: a.lte } }, _sum: { quantity: true } });
    const stock = await a.tx.stockBalance.groupBy({ by: ['variantId'], where: { tenantId: a.ctx.tenantId, branchId: { in: a.branches } }, _sum: { quantity: true } });
    const days = Math.max(1, Math.round((a.lte.getTime() - a.gte.getTime()) / 86400_000));
    const rows = [...names.entries()].filter(([, v]) => v.active).map(([id, v]) => {
      const units = -Number(sold.find((s) => s.variantId === id)?._sum.quantity ?? 0);
      const on = Number(stock.find((s) => s.variantId === id)?._sum.quantity ?? 0);
      return { product: v.name, sku: v.sku, sold: units, stock: on, rotation: on > 0 ? round2(units / on) : 0, coverage: units > 0 ? Math.round((Math.max(on, 0) / units) * days) : '' };
    }).filter((r) => r.sold !== 0 || r.stock !== 0).sort((x, y) => y.rotation - x.rotation);
    return { columns: [c('product', 'Producto'), c('sku', 'SKU'), c('sold', 'Vendido', 'number'), c('stock', 'Stock actual', 'number'), c('rotation', 'Rotación (vendido/stock)', 'number'), c('coverage', 'Días de cobertura', 'number')], rows };
  },
  async no_movement(a) {
    const names = await productNames(a);
    const stock = await a.tx.stockBalance.groupBy({ by: ['variantId'], where: { tenantId: a.ctx.tenantId, branchId: { in: a.branches } }, _sum: { quantity: true } });
    const sold = new Set((await a.tx.stockMovement.findMany({ where: { tenantId: a.ctx.tenantId, branchId: { in: a.branches }, type: 'SALE', occurredAt: { gte: a.gte, lte: a.lte } }, distinct: ['variantId'], select: { variantId: true } })).map((m) => m.variantId));
    const last = await a.tx.stockMovement.groupBy({ by: ['variantId'], where: { tenantId: a.ctx.tenantId, branchId: { in: a.branches }, type: 'SALE' }, _max: { occurredAt: true } });
    const rows = stock.map((s) => ({ id: s.variantId, q: Number(s._sum.quantity ?? 0) })).filter((s) => s.q > 0 && !sold.has(s.id)).map((s) => {
      const v = names.get(s.id)!;
      const when = last.find((l) => l.variantId === s.id)?._max.occurredAt;
      return { product: v.name, sku: v.sku, stock: s.q, value: round2(s.q * v.cost), lastSale: when ? todayISO(when) : 'Nunca' };
    }).sort((x, y) => y.value - x.value);
    return { columns: [c('product', 'Producto'), c('sku', 'SKU'), c('stock', 'Stock', 'number'), c('value', 'Valor al costo', 'money'), c('lastSale', 'Última venta')], rows, sum: ['stock', 'value'] };
  },
  async waste_expired(a) {
    const names = await productNames(a);
    const branches = await branchNames(a);
    const waste = await a.tx.stockMovement.findMany({ where: { tenantId: a.ctx.tenantId, branchId: { in: a.branches }, type: 'WASTE', occurredAt: { gte: a.gte, lte: a.lte } }, orderBy: { occurredAt: 'desc' } });
    const rows: Row[] = waste.map((m) => ({ type: 'Merma', date: todayISO(m.occurredAt), branch: branches.get(m.branchId) ?? '', product: names.get(m.variantId)?.name ?? '', quantity: -Number(m.quantity), value: round2(-Number(m.quantity) * Number(m.unitCost)), detail: m.reason }));
    const lots = await a.tx.lot.findMany({ where: { tenantId: a.ctx.tenantId, expiresAt: { lt: new Date(`${todayISO()}T00:00:00Z`) } } });
    const balances = await a.tx.stockBalance.findMany({ where: { tenantId: a.ctx.tenantId, branchId: { in: a.branches }, lotKey: { in: lots.map((l) => l.id) }, quantity: { gt: 0 } } });
    for (const b of balances) {
      const lot = lots.find((l) => l.id === b.lotKey)!;
      const v = names.get(b.variantId)!;
      rows.push({ type: 'Vencido en stock', date: lot.expiresAt!.toISOString().slice(0, 10), branch: branches.get(b.branchId) ?? '', product: v.name, quantity: Number(b.quantity), value: round2(Number(b.quantity) * v.cost), detail: `Lote ${lot.code}` });
    }
    return { columns: [c('type', 'Tipo'), c('date', 'Fecha'), c('branch', 'Sucursal'), c('product', 'Producto'), c('quantity', 'Cantidad', 'number'), c('value', 'Valor al costo', 'money'), c('detail', 'Detalle')], rows, sum: ['quantity', 'value'] };
  },
  async cash_closes(a) {
    const names = await userNames(a.tx, a.ctx);
    const branches = await branchNames(a);
    const sessions = await a.tx.cashSession.findMany({ where: { tenantId: a.ctx.tenantId, branchId: { in: a.branches }, closedAt: { gte: a.gte, lte: a.lte } }, orderBy: { closedAt: 'desc' } });
    const total = (v: unknown) => round2(Object.values((v ?? {}) as Record<string, number>).reduce((s, n) => s + n, 0));
    return {
      columns: [c('date', 'Cierre'), c('branch', 'Sucursal'), c('user', 'Usuario'), c('opening', 'Apertura', 'money'), c('expected', 'Esperado', 'money'), c('counted', 'Contado', 'money'), c('difference', 'Diferencia', 'money'), c('reviewed', 'Revisado por')],
      rows: sessions.map((s) => ({ date: s.closedAt!.toLocaleString('es-PE', { timeZone: 'America/Lima' }), branch: branches.get(s.branchId) ?? '', user: names.get(s.userId) ?? '', opening: Number(s.openingAmount), expected: total(s.expected), counted: total(s.counted), difference: Number(s.difference ?? 0), reviewed: s.reviewedBy ? names.get(s.reviewedBy) ?? '' : 'Pendiente' })),
      sum: ['difference'],
    };
  },
};

export async function buildReport(ctx: Ctx, type: ReportType, filter: RangeFilter): Promise<Report> {
  need(ctx, 'reports.view');
  const branches = branchScope(ctx, filter.branchId);
  const range = dateRange(filter);
  return withTenant(ctx.tenantId, async (tx) => {
    const { columns, rows, sum } = branches.length
      ? await builders[type]({ tx, ctx, branches, gte: range.gte, lte: range.lte })
      : { columns: [], rows: [], sum: undefined };
    const totals = sum && rows.length ? Object.fromEntries(sum.map((k) => [k, round2(rows.reduce((s, r) => s + Number(r[k] || 0), 0))])) : undefined;
    return { title: REPORTS[type], subtitle: `Del ${range.from} al ${range.to}`, columns, rows, totals };
  }, { timeout: 60_000, readOnly: true });
}
