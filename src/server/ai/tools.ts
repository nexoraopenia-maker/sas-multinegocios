import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { computeAlerts } from '@/shared/alerts';
import type { AttributeValues } from '@/shared/attributes';
import { alertSwitches, variantLabel } from '@/shared/snapshot';
import type { Ctx } from '../context';
import { withTenant, type Tx } from '../db';
import { readSettings } from '../domain/queries';

const MAX_ROWS = 40;
const object = (properties: Record<string, object>, required: string[]): Anthropic.Tool.InputSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const branchProp = { type: 'string', description: 'Nombre o código de sucursal. Cadena vacía = todas.' };

/** Herramientas de solo lectura. Ninguna recibe el negocio: se toma de la sesión. */
export const TOOLS: Anthropic.Tool[] = [
  { name: 'buscar_stock', description: 'Busca productos por nombre, marca, atributo (talla, color...), SKU o código y devuelve precio y stock por sucursal y lote.',
    input_schema: object({ texto: { type: 'string', description: 'Palabras a buscar; todas deben coincidir' }, sucursal: branchProp }, ['texto', 'sucursal']) },
  { name: 'vencimientos', description: 'Lista lotes vencidos o por vencer con existencias.',
    input_schema: object({ estado: { type: 'string', enum: ['vencidos', 'por_vencer'] }, dias: { type: 'integer', description: 'Días de anticipación para por_vencer; 0 = configuración del negocio' }, sucursal: branchProp }, ['estado', 'dias', 'sucursal']) },
  { name: 'bajo_stock', description: 'Lista productos cuyo stock está en o por debajo del mínimo configurado.', input_schema: object({ sucursal: branchProp }, ['sucursal']) },
  { name: 'sucursales', description: 'Lista las sucursales del negocio.', input_schema: object({}, []) },
];

const schemas = {
  buscar_stock: z.object({ texto: z.string().max(200), sucursal: z.string().max(80).default('') }),
  vencimientos: z.object({ estado: z.enum(['vencidos', 'por_vencer']), dias: z.number().int().min(0).max(730).default(0), sucursal: z.string().max(80).default('') }),
  bajo_stock: z.object({ sucursal: z.string().max(80).default('') }),
  sucursales: z.object({}),
};

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function load(tx: Tx, ctx: Ctx, branchText: string) {
  const tenantId = ctx.tenantId;
  const all = await tx.branch.findMany({ where: { tenantId, active: true, ...(ctx.features.multiBranch ? {} : { id: { in: ctx.branchIds } }) } });
  const q = fold(branchText.trim());
  const branches = q ? all.filter((b) => fold(b.name).includes(q) || fold(b.code) === q) : all;
  const rows = await tx.variant.findMany({ where: { tenantId, active: true, product: { active: true } }, include: { product: true } });
  const variants = rows.map((v) => ({
    id: v.id, sku: v.sku, barcode: v.barcode, price: Number(v.price), minStock: Number(v.minStock), tracksExpiry: v.product.tracksExpiry, active: true,
    label: variantLabel(v.product, { attributes: v.attributes as AttributeValues }),
    search: fold([v.product.name, v.product.brand, v.sku, v.barcode, ...Object.values({ ...(v.product.attributes as object), ...(v.attributes as object) })].join(' ')),
  }));
  const balances = (await tx.stockBalance.findMany({ where: { tenantId, branchId: { in: branches.map((b) => b.id) } } }))
    .map((b) => ({ branchId: b.branchId, variantId: b.variantId, lotId: b.lotKey || null, quantity: Number(b.quantity) }));
  const lots = (await tx.lot.findMany({ where: { tenantId } })).map((l) => ({ id: l.id, variantId: l.variantId, code: l.code, expiresAt: l.expiresAt?.toISOString().slice(0, 10) ?? null }));
  return { branches, variants, balances, lots };
}

export async function runTool(ctx: Ctx, name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
  const schema = schemas[name as keyof typeof schemas];
  const parsed = schema?.safeParse(input);
  if (!parsed?.success) return { content: 'Herramienta o parámetros no válidos', isError: true };
  const args = parsed.data as { texto?: string; sucursal?: string; estado?: string; dias?: number };
  // La base de datos rechaza cualquier escritura dentro de esta transacción.
  const data = await withTenant(ctx.tenantId, async (tx) => {
    const d = await load(tx, ctx, args.sucursal ?? '');
    if (name === 'sucursales') return d.branches.map((b) => ({ codigo: b.code, nombre: b.name, direccion: b.address }));
    if (args.sucursal && !d.branches.length) return { error: 'No existe esa sucursal' };
    const branchName = new Map(d.branches.map((b) => [b.id, b.name]));
    if (name === 'buscar_stock') {
      const words = fold(args.texto ?? '').split(/\s+/).filter(Boolean);
      const found = d.variants.filter((v) => words.every((w) => v.search.includes(w)));
      return {
        total: found.length,
        productos: found.slice(0, MAX_ROWS).map((v) => ({
          producto: v.label, sku: v.sku, precio: v.price, stockMinimo: v.minStock,
          stock: d.branches.map((b) => {
            const own = d.balances.filter((x) => x.branchId === b.id && x.variantId === v.id);
            return {
              sucursal: b.name, cantidad: own.reduce((s, x) => s + x.quantity, 0),
              lotes: own.filter((x) => x.lotId && x.quantity !== 0).map((x) => {
                const l = d.lots.find((lot) => lot.id === x.lotId);
                return { lote: l?.code, vence: l?.expiresAt, cantidad: x.quantity };
              }),
            };
          }),
        })),
      };
    }
    const settings = await readSettings(tx, ctx);
    const switches = alertSwitches(ctx.features, settings);
    const alerts = computeAlerts({ ...d, branchIds: d.branches.map((b) => b.id), switches: { ...switches, expired: true, expiring: true, lowStock: true, daysAhead: args.dias || switches.daysAhead } });
    const list = name === 'bajo_stock' ? alerts.lowStock : args.estado === 'vencidos' ? alerts.expired : alerts.expiring;
    return { total: list.length, items: list.slice(0, MAX_ROWS).map(({ variantId: _v, branchId, ...rest }) => ({ ...rest, sucursal: branchName.get(branchId) })) };
  }, { readOnly: true });
  return { content: JSON.stringify(data), isError: false };
}
