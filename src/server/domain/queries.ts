import type { AttributeDef, AttributeValues } from '@/shared/attributes';
import { DEFAULT_LABEL, type LabelFormat, type Snapshot, type SettingsDto } from '@/shared/snapshot';
import { todayISO } from '@/shared/stock';
import { need, needBranch, type Ctx } from '../context';
import { withTenant, type Tx } from '../db';
import { notFound, forbidden } from '../errors';
import { expectedTotals } from './cash';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export async function readSettings(tx: Tx, ctx: Ctx): Promise<SettingsDto> {
  const s = await tx.tenantSettings.findUniqueOrThrow({ where: { tenantId: ctx.tenantId } });
  const { tenantId: _omit, maxSellerDiscountPct, labelFormat, ...rest } = s;
  void _omit;
  return { ...rest, maxSellerDiscountPct: Number(maxSellerDiscountPct), labelFormat: { ...DEFAULT_LABEL, ...(labelFormat as Partial<LabelFormat>) } };
}

export async function userNames(tx: Tx, ctx: Ctx) {
  const users = await tx.user.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

/** Catálogo y existencias para operar sin conexión. Todas las sucursales activas se ven en solo lectura. */
export async function buildSnapshot(ctx: Ctx, branchId: string, deviceKey: string): Promise<Snapshot> {
  need(ctx, 'catalog.view');
  needBranch(ctx, branchId);
  const seeCost = ctx.permissions.has('cost.view');
  return withTenant(ctx.tenantId, async (tx) => {
    const tenantId = ctx.tenantId;
    const settings = await readSettings(tx, ctx);
    const allBranches = await tx.branch.findMany({ where: { tenantId }, orderBy: { code: 'asc' } });
    const branches = ctx.features.multiBranch ? allBranches.filter((b) => b.active) : allBranches.filter((b) => ctx.branchIds.includes(b.id));
    const categories = await tx.category.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
    const products = await tx.product.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
    const variants = await tx.variant.findMany({ where: { tenantId } });
    const lots = await tx.lot.findMany({ where: { tenantId } });
    const balances = await tx.stockBalance.findMany({ where: { tenantId, branchId: { in: branches.map((b) => b.id) }, NOT: { quantity: 0 } } });
    const customers = await tx.customer.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 500 });
    const cash = await tx.cashSession.findFirst({ where: { tenantId, branchId, deviceKey, closedAt: null } });
    const transfers = ctx.features.multiBranch
      ? await tx.transfer.findMany({
          where: { tenantId, OR: [{ fromBranchId: { in: ctx.branchIds } }, { toBranchId: { in: ctx.branchIds } }] },
          include: { items: true }, orderBy: { requestedAt: 'desc' }, take: 100,
        })
      : [];
    const adjustments = await tx.adjustment.findMany({ where: { tenantId, branchId: { in: ctx.branchIds } }, orderBy: { requestedAt: 'desc' }, take: 100 });
    const names = await userNames(tx, ctx);
    const openNotices = ctx.permissions.has('notices.review')
      ? await tx.supervisorNotice.count({ where: { tenantId, resolvedAt: null, OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] } })
      : 0;
    return {
      takenAt: new Date().toISOString(), branchId, settings, openNotices,
      branches: branches.map((b) => ({ id: b.id, code: b.code, name: b.name, address: b.address, active: b.active })),
      categories: categories.map((c) => ({ id: c.id, name: c.name, tracksExpiry: c.tracksExpiry, attributes: c.attributes as unknown as AttributeDef[] })),
      products: products.map((p) => ({ id: p.id, categoryId: p.categoryId, name: p.name, brand: p.brand, description: p.description, tracksExpiry: p.tracksExpiry, attributes: p.attributes as AttributeValues, active: p.active })),
      variants: variants.map((v) => ({ id: v.id, productId: v.productId, sku: v.sku, barcode: v.barcode, attributes: v.attributes as AttributeValues, price: Number(v.price), cost: seeCost ? Number(v.cost) : null, minStock: Number(v.minStock), active: v.active })),
      lots: lots.map((l) => ({ id: l.id, variantId: l.variantId, code: l.code, expiresAt: day(l.expiresAt) })),
      balances: balances.map((b) => ({ branchId: b.branchId, variantId: b.variantId, lotId: b.lotKey || null, quantity: Number(b.quantity) })),
      customers: customers.map((c) => ({ id: c.id, name: c.name, docNumber: c.docNumber, phone: c.phone, email: c.email })),
      cashSession: cash ? { id: cash.id, branchId: cash.branchId, deviceKey: cash.deviceKey, userId: cash.userId, openedAt: cash.openedAt.toISOString(), openingAmount: Number(cash.openingAmount) } : null,
      transfers: transfers.map((t) => ({
        id: t.id, fromBranchId: t.fromBranchId, toBranchId: t.toBranchId, status: t.status, notes: t.notes, requestedAt: t.requestedAt.toISOString(),
        items: t.items.map((i) => ({ variantId: i.variantId, requested: Number(i.requested), shipped: Number(i.shipped), received: Number(i.received) })),
      })),
      adjustments: adjustments.map((a) => ({
        id: a.id, branchId: a.branchId, kind: a.kind, status: a.status, reason: a.reason, requestedAt: a.requestedAt.toISOString(),
        requestedByName: names.get(a.requestedBy) ?? '', items: a.items as unknown as Snapshot['adjustments'][number]['items'],
      })),
    };
  }, { timeout: 60_000 });
}

export interface RangeFilter { branchId?: string; from?: string; to?: string }

/** Rango de fechas locales (Perú, UTC-5) convertido a instantes UTC. */
export function dateRange(f: RangeFilter, defaultDays = 30) {
  const to = f.to ?? todayISO();
  const from = f.from ?? todayISO(new Date(Date.now() - defaultDays * 86400_000));
  return { from, to, gte: new Date(`${from}T00:00:00-05:00`), lte: new Date(`${to}T23:59:59.999-05:00`) };
}

export function branchScope(ctx: Ctx, branchId?: string) {
  if (!branchId) return ctx.branchIds;
  needBranch(ctx, branchId);
  return [branchId];
}

export async function kardex(ctx: Ctx, f: RangeFilter & { variantId?: string }) {
  need(ctx, 'catalog.view');
  const branchIds = branchScope(ctx, f.branchId);
  const range = dateRange(f, 90);
  return withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx.stockMovement.findMany({
      where: { tenantId: ctx.tenantId, branchId: { in: branchIds }, occurredAt: { gte: range.gte, lte: range.lte }, ...(f.variantId ? { variantId: f.variantId } : {}) },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take: 500,
    });
    const names = await userNames(tx, ctx);
    return rows.map((m) => ({
      id: m.id, branchId: m.branchId, variantId: m.variantId, lotId: m.lotId, type: m.type, quantity: Number(m.quantity),
      reason: m.reason, user: names.get(m.userId) ?? '', occurredAt: m.occurredAt.toISOString(),
    }));
  });
}

export async function listSales(ctx: Ctx, f: RangeFilter) {
  need(ctx, 'pos.sell');
  const branchIds = branchScope(ctx, f.branchId);
  const range = dateRange(f, 7);
  const own = !ctx.permissions.has('reports.view');
  return withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx.sale.findMany({
      where: { tenantId: ctx.tenantId, branchId: { in: branchIds }, occurredAt: { gte: range.gte, lte: range.lte }, ...(own ? { userId: ctx.userId } : {}) },
      orderBy: { occurredAt: 'desc' }, take: 300, include: { payments: true },
    });
    const names = await userNames(tx, ctx);
    return rows.map((s) => ({
      id: s.id, branchId: s.branchId, series: s.series, number: s.number, total: Number(s.total), status: s.status,
      user: names.get(s.userId) ?? '', occurredAt: s.occurredAt.toISOString(), methods: [...new Set(s.payments.filter((p) => Number(p.amount) > 0).map((p) => p.method))],
    }));
  });
}

export async function saleDetail(ctx: Ctx, id: string) {
  need(ctx, 'pos.sell');
  return withTenant(ctx.tenantId, async (tx) => {
    const s = await tx.sale.findFirst({ where: { tenantId: ctx.tenantId, id }, include: { items: true, payments: true } });
    if (!s) throw notFound('Venta');
    needBranch(ctx, s.branchId);
    if (!ctx.permissions.has('reports.view') && s.userId !== ctx.userId) throw forbidden('Solo puedes ver tus ventas');
    const customer = s.customerId ? await tx.customer.findFirst({ where: { tenantId: ctx.tenantId, id: s.customerId } }) : null;
    const returns = await tx.saleReturn.findMany({ where: { tenantId: ctx.tenantId, saleId: id } });
    const vouchers = await tx.voucher.findMany({ where: { tenantId: ctx.tenantId, returnId: { in: returns.map((r) => r.id) } } });
    const names = await userNames(tx, ctx);
    return {
      id: s.id, branchId: s.branchId, series: s.series, number: s.number, status: s.status, voidReason: s.voidReason,
      subtotal: Number(s.subtotal), discount: Number(s.discount), total: Number(s.total), occurredAt: s.occurredAt.toISOString(), user: names.get(s.userId) ?? '',
      customer: customer ? { name: customer.name, docNumber: customer.docNumber, phone: customer.phone, email: customer.email } : null,
      items: s.items.map((i) => ({ id: i.id, variantId: i.variantId, description: i.description, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice), discount: Number(i.discount), total: Number(i.total), returnedQty: Number(i.returnedQty) })),
      payments: s.payments.map((p) => ({ method: p.method, amount: Number(p.amount), reference: p.reference })),
      returns: returns.map((r) => ({ id: r.id, total: Number(r.total), reason: r.reason, refundMethod: r.refundMethod, occurredAt: r.occurredAt.toISOString(), voucherCode: vouchers.find((v) => v.returnId === r.id)?.code ?? null })),
    };
  });
}

export async function findVoucher(ctx: Ctx, code: string) {
  need(ctx, 'pos.sell');
  const v = await withTenant(ctx.tenantId, (tx) => tx.voucher.findFirst({ where: { tenantId: ctx.tenantId, code: code.trim().toUpperCase() } }));
  if (!v) throw notFound('Vale');
  return { code: v.code, balance: Number(v.balance) };
}

export async function cashSessions(ctx: Ctx, f: RangeFilter) {
  need(ctx, 'cash.operate');
  const branchIds = branchScope(ctx, f.branchId);
  const range = dateRange(f, 15);
  return withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx.cashSession.findMany({
      where: { tenantId: ctx.tenantId, branchId: { in: branchIds }, openedAt: { gte: range.gte, lte: range.lte }, ...(ctx.permissions.has('cash.review') ? {} : { userId: ctx.userId }) },
      orderBy: { openedAt: 'desc' }, take: 100,
    });
    const names = await userNames(tx, ctx);
    const out = [];
    for (const s of rows) {
      // El vendedor no ve el esperado antes de contar (arqueo ciego).
      const live = !s.closedAt && ctx.permissions.has('cash.review') ? await expectedTotals(tx, ctx, s.id, Number(s.openingAmount)) : null;
      out.push({
        id: s.id, branchId: s.branchId, user: names.get(s.userId) ?? '', openedAt: s.openedAt.toISOString(), closedAt: iso(s.closedAt),
        openingAmount: Number(s.openingAmount), expected: (s.expected as Record<string, number> | null) ?? live,
        counted: s.counted as Record<string, number> | null, difference: s.difference === null ? null : Number(s.difference),
        notes: s.notes, reviewedBy: s.reviewedBy ? names.get(s.reviewedBy) ?? '' : null,
      });
    }
    return out;
  });
}

export async function reviewCash(ctx: Ctx, id: string) {
  need(ctx, 'cash.review');
  return withTenant(ctx.tenantId, async (tx) => {
    const s = await tx.cashSession.findFirst({ where: { tenantId: ctx.tenantId, id, closedAt: { not: null } } });
    if (!s) throw notFound('Caja cerrada');
    needBranch(ctx, s.branchId);
    await tx.cashSession.update({ where: { id }, data: { reviewedBy: ctx.userId, reviewedAt: new Date() } });
    return { ok: true };
  });
}

export async function listNotices(ctx: Ctx) {
  need(ctx, 'notices.review');
  return withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx.supervisorNotice.findMany({
      where: { tenantId: ctx.tenantId, resolvedAt: null, OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
    return rows.map((n) => ({ id: n.id, branchId: n.branchId, type: n.type, message: n.message, createdAt: n.createdAt.toISOString() }));
  });
}

export async function resolveNotice(ctx: Ctx, id: string) {
  need(ctx, 'notices.review');
  return withTenant(ctx.tenantId, async (tx) => {
    const r = await tx.supervisorNotice.updateMany({
      where: { tenantId: ctx.tenantId, id, resolvedAt: null, OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] },
      data: { resolvedAt: new Date(), resolvedBy: ctx.userId },
    });
    if (!r.count) throw notFound('Aviso');
    return { ok: true };
  });
}
