/** Indicadores del panel principal. Mismas definiciones que los reportes (ventas netas de devoluciones). */
import { Prisma } from '@/generated/prisma/client';
import { DASHBOARD_PERIODS, type Dashboard } from '@/shared/dashboard';
import { round2, round3 } from '@/shared/money';
import { addDays, todayISO } from '@/shared/stock';
import { need, type Ctx } from '../context';
import { withTenant } from '../db';
import { branchScope, dateRange } from '../domain/queries';

type Num = bigint | number | Prisma.Decimal | null;
const num = (v: Num | undefined) => Number(v ?? 0);

export async function dashboard(ctx: Ctx, filter: { branchId?: string; days?: number }): Promise<Dashboard> {
  need(ctx, 'reports.view');
  const days = DASHBOARD_PERIODS.find((d) => d === filter.days) ?? 30;
  const to = todayISO();
  const from = addDays(to, 1 - days);
  const { gte, lte } = dateRange({ from, to });
  const branches = branchScope(ctx, filter.branchId);
  const seeCost = ctx.permissions.has('cost.view');
  const scanLink = ctx.permissions.has('stock.in');
  const tenantId = ctx.tenantId;

  return withTenant(tenantId, async (tx) => {
    const inBranches = Prisma.join(branches.length ? branches : ['']);
    const sales = await tx.$queryRaw<{ date: string; count: Num; net: Num }[]>`
      SELECT to_char((s."occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Lima', 'YYYY-MM-DD') AS date,
             count(*) AS count, sum(s."total") - coalesce(sum(r.returned), 0) AS net
      FROM "Sale" s
      LEFT JOIN (SELECT "saleId", sum("total") AS returned FROM "SaleReturn" WHERE "tenantId" = ${tenantId} GROUP BY "saleId") r ON r."saleId" = s."id"
      WHERE s."tenantId" = ${tenantId} AND s."status" = 'COMPLETED' AND s."branchId" IN (${inBranches})
        AND s."occurredAt" BETWEEN ${gte} AND ${lte}
      GROUP BY 1`;
    const byDate = new Map(sales.map((r) => [r.date, r]));
    const series = Array.from({ length: days }, (_, i) => {
      const date = addDays(from, i);
      return { date, count: num(byDate.get(date)?.count), net: round2(num(byDate.get(date)?.net)) };
    });
    const count = series.reduce((s, d) => s + d.count, 0);
    const net = round2(series.reduce((s, d) => s + d.net, 0));
    const last = series[series.length - 1];

    let margin: Dashboard['margin'] = null;
    let valuation: Dashboard['valuation'] = null;
    if (seeCost) {
      const [m] = await tx.$queryRaw<{ revenue: Num; cost: Num }[]>`
        SELECT sum(i."total" * (i."quantity" - i."returnedQty") / i."quantity") AS revenue,
               sum(i."unitCost" * (i."quantity" - i."returnedQty")) AS cost
        FROM "SaleItem" i JOIN "Sale" s ON s."id" = i."saleId" AND s."tenantId" = i."tenantId"
        WHERE s."tenantId" = ${tenantId} AND s."status" = 'COMPLETED' AND s."branchId" IN (${inBranches})
          AND s."occurredAt" BETWEEN ${gte} AND ${lte}`;
      const amount = round2(num(m?.revenue) - num(m?.cost));
      margin = { amount, percent: num(m?.revenue) > 0 ? round2((amount / num(m.revenue)) * 100) : 0 };
      const [v] = await tx.$queryRaw<{ cost: Num; sale: Num }[]>`
        SELECT sum(greatest(b.q, 0) * v."cost") AS cost, sum(greatest(b.q, 0) * v."price") AS sale
        FROM (SELECT "branchId", "variantId", sum("quantity") AS q FROM "StockBalance"
              WHERE "tenantId" = ${tenantId} AND "branchId" IN (${inBranches}) GROUP BY 1, 2) b
        JOIN "Variant" v ON v."id" = b."variantId" AND v."tenantId" = ${tenantId}`;
      const cost = round2(num(v?.cost));
      const sale = round2(num(v?.sale));
      valuation = { cost, sale, potential: round2(sale - cost) };
    }

    const [totals] = await tx.$queryRaw<{ count: Num; total: Num }[]>`
      SELECT count(DISTINCT "refId") AS count, sum("quantity" * "unitCost") AS total FROM "StockMovement"
      WHERE "tenantId" = ${tenantId} AND "type" = 'PURCHASE' AND "branchId" IN (${inBranches}) AND "occurredAt" BETWEEN ${gte} AND ${lte}`;
    const recent = await tx.$queryRaw<{ id: string; occurredAt: Date; branchId: string; reason: string; lines: Num; units: Num; total: Num }[]>`
      SELECT "refId" AS id, max("occurredAt") AS "occurredAt", "branchId", max("reason") AS reason,
             count(*) AS lines, sum("quantity") AS units, sum("quantity" * "unitCost") AS total
      FROM "StockMovement"
      WHERE "tenantId" = ${tenantId} AND "type" = 'PURCHASE' AND "branchId" IN (${inBranches})
      GROUP BY "refId", "branchId" ORDER BY 2 DESC LIMIT 6`;
    const names = new Map((await tx.branch.findMany({ where: { tenantId } })).map((b) => [b.id, b.name]));
    const scans = scanLink && recent.length
      ? await tx.purchaseScan.findMany({ where: { tenantId, operationId: { in: recent.map((r) => r.id) } }, select: { id: true, operationId: true } })
      : [];

    const movements = await tx.$queryRaw<{ type: string; in: Num; out: Num }[]>`
      SELECT "type"::text AS type, sum(greatest("quantity", 0)) AS "in", sum(greatest(-"quantity", 0)) AS out FROM "StockMovement"
      WHERE "tenantId" = ${tenantId} AND "branchId" IN (${inBranches}) AND "occurredAt" BETWEEN ${gte} AND ${lte}
      GROUP BY 1`;

    return {
      from, to, days, series,
      today: { count: last.count, net: last.net },
      period: { count, net, average: count ? round2(net / count) : 0 },
      margin, valuation,
      purchases: {
        count: num(totals?.count), total: seeCost ? round2(num(totals?.total)) : null,
        recent: recent.map((r) => ({
          id: r.id, occurredAt: r.occurredAt.toISOString(), branch: names.get(r.branchId) ?? '', reason: r.reason,
          lines: num(r.lines), units: round3(num(r.units)), total: seeCost ? round2(num(r.total)) : null,
          scanId: scans.find((s) => s.operationId === r.id)?.id ?? null,
        })),
      },
      movements: movements.map((m) => ({ type: m.type, in: round3(num(m.in)), out: round3(num(m.out)) }))
        .sort((a, b) => b.in + b.out - (a.in + a.out)),
    };
  }, { timeout: 60_000, readOnly: true });
}
