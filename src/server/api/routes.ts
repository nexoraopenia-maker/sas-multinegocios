import { NextResponse } from 'next/server';
import { z } from 'zod';
import { operationSchema } from '@/shared/operations';
import { REPORTS, type ReportType } from '@/shared/reports';
import { askAgent } from '../ai/agent';
import { changePassword, login, logout, SESSION_COOKIE, toSessionUser } from '../auth';
import { withTenant } from '../db';
import { AppError, notFound } from '../errors';
import * as admin from '../domain/admin';
import { categoryInput, productInput, saveCategory, saveProduct } from '../domain/catalog';
import { importProducts, importTemplate } from '../domain/import';
import * as q from '../domain/queries';
import { processOperation, registerDevice, type OpResult } from '../domain/sync';
import { toPdf, toXlsx } from '../reports/export';
import { buildReport } from '../reports/reports';
import { body, clientIp, type Route } from './http';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const file = (data: Buffer, type: string, name: string) =>
  new Response(new Uint8Array(data), { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` } });

const date = z.string().date().optional();
const range = z.object({ branchId: z.string().optional(), from: date, to: date, variantId: z.string().optional() });

export const routes: Route[] = [
  // ── Sesión ──
  { method: 'POST', path: 'auth/login', access: 'public', handler: async ({ req }) => {
    const input = await body(req, z.object({ email: z.string().max(120), password: z.string().max(200) }));
    const s = await login(input.email, input.password, clientIp(req.headers));
    const res = NextResponse.json({ role: s.role, mustChangePassword: s.mustChangePassword });
    res.cookies.set(SESSION_COOKIE, s.token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires: s.expiresAt });
    return res;
  } },
  { method: 'POST', path: 'auth/logout', access: 'public', handler: async ({ token }) => {
    await logout(token);
    const res = NextResponse.json({ ok: true });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  } },
  { method: 'POST', path: 'auth/change-password', access: 'any', handler: async ({ req, token, auth }) => {
    const input = await body(req, z.object({ current: z.string().max(200), next: z.string().max(200) }));
    await changePassword(token, auth, input.current, input.next);
    return { role: auth.role };
  } },
  { method: 'GET', path: 'auth/me', access: 'any', handler: async ({ auth }) =>
    auth.ctx ? { user: toSessionUser(auth) } : { user: null, role: auth.role, mustChangePassword: auth.mustChangePassword } },

  // ── Sincronización ──
  { method: 'POST', path: 'sync/device', handler: async ({ req, ctx }) =>
    registerDevice(ctx, await body(req, z.object({ deviceKey: z.string().uuid(), branchId: z.string(), name: z.string().max(100) }))) },
  { method: 'POST', path: 'sync/push', handler: async ({ req, ctx }) => {
    const input = await body(req, z.object({ deviceKey: z.string().uuid(), pending: z.number().int().min(0).default(0), operations: z.array(operationSchema).max(50) }));
    const results: OpResult[] = [];
    let interrupted = false;
    // En orden: una venta depende de la apertura de caja que va antes.
    for (const op of input.operations) {
      try {
        results.push(await processOperation(ctx, input.deviceKey, op));
      } catch (e) {
        console.error(e);
        interrupted = true;
        break;
      }
    }
    await withTenant(ctx.tenantId, (tx) => tx.device.updateMany({
      where: { tenantId: ctx.tenantId, deviceKey: input.deviceKey },
      data: { lastSyncAt: new Date(), pendingCount: Math.max(0, input.pending - results.length) },
    }));
    return { results, interrupted };
  } },
  { method: 'GET', path: 'sync/pull', handler: async ({ ctx, query }) => q.buildSnapshot(ctx, query.branchId ?? '', query.deviceKey ?? '') },

  // ── Catálogo e inventario ──
  { method: 'POST', path: 'catalog/categories', handler: async ({ req, ctx }) => saveCategory(ctx, await body(req, categoryInput)) },
  { method: 'POST', path: 'catalog/products', handler: async ({ req, ctx }) => saveProduct(ctx, await body(req, productInput)) },
  { method: 'GET', path: 'catalog/import-template', handler: async ({ ctx }) => file(await importTemplate(ctx), XLSX, 'plantilla-productos.xlsx') },
  { method: 'POST', path: 'catalog/import', handler: async ({ req, ctx }) => {
    if (Number(req.headers.get('content-length') ?? 0) > 4_000_000) throw new AppError('El archivo supera 4 MB', 413);
    const form = await req.formData();
    const upload = form.get('file');
    if (!(upload instanceof File) || upload.size > 4_000_000) throw new AppError('Adjunta un archivo .xlsx o .csv de hasta 4 MB');
    return importProducts(ctx, { file: Buffer.from(await upload.arrayBuffer()), filename: upload.name, branchId: String(form.get('branchId')), dryRun: form.get('dryRun') !== 'false' });
  } },
  { method: 'GET', path: 'inventory/kardex', handler: async ({ ctx, query }) => q.kardex(ctx, range.parse(query)) },

  // ── Ventas y caja ──
  { method: 'GET', path: 'sales', handler: async ({ ctx, query }) => q.listSales(ctx, range.parse(query)) },
  { method: 'GET', path: 'sales/:id', handler: async ({ ctx, params }) => q.saleDetail(ctx, params.id) },
  { method: 'GET', path: 'vouchers/:code', handler: async ({ ctx, params }) => q.findVoucher(ctx, params.code) },
  { method: 'GET', path: 'cash', handler: async ({ ctx, query }) => q.cashSessions(ctx, range.parse(query)) },
  { method: 'POST', path: 'cash/:id/review', handler: async ({ ctx, params }) => q.reviewCash(ctx, params.id) },
  { method: 'GET', path: 'notices', handler: async ({ ctx }) => q.listNotices(ctx) },
  { method: 'POST', path: 'notices/:id/resolve', handler: async ({ ctx, params }) => q.resolveNotice(ctx, params.id) },

  // ── Administración del negocio ──
  { method: 'GET', path: 'settings', handler: async ({ ctx }) => admin.getSettings(ctx) },
  { method: 'POST', path: 'settings', handler: async ({ req, ctx }) => admin.saveSettings(ctx, await body(req, admin.settingsInput)) },
  { method: 'GET', path: 'branches', handler: async ({ ctx }) => admin.listBranches(ctx) },
  { method: 'POST', path: 'branches', handler: async ({ req, ctx }) => admin.saveBranch(ctx, await body(req, admin.branchInput)) },
  { method: 'GET', path: 'users', handler: async ({ ctx }) => admin.listUsers(ctx) },
  { method: 'POST', path: 'users', handler: async ({ req, ctx }) => admin.saveUser(ctx, await body(req, admin.userInput)) },
  { method: 'GET', path: 'sunat', handler: async ({ ctx }) => admin.getSunat(ctx) },
  { method: 'POST', path: 'sunat', handler: async ({ req, ctx }) => admin.saveSunat(ctx, await body(req, admin.sunatInput)) },

  // ── Reportes y agente ──
  { method: 'GET', path: 'reports/:type', handler: async ({ ctx, params, query }) => {
    if (!(params.type in REPORTS)) throw notFound('Reporte');
    const report = await buildReport(ctx, params.type as ReportType, range.parse(query));
    if (query.format === 'xlsx') return file(await toXlsx(report), XLSX, `${params.type}.xlsx`);
    if (query.format === 'pdf') return file(await toPdf(report), 'application/pdf', `${params.type}.pdf`);
    return report;
  } },
  { method: 'POST', path: 'agent', handler: async ({ req, ctx }) =>
    askAgent(ctx, (await body(req, z.object({ question: z.string().trim().min(2).max(600) }))).question) },
];
