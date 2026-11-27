import { z } from 'zod';
import { attributeDefSchema, validateAttributes, type AttributeDef } from '@/shared/attributes';
import { internalBarcode, internalSku } from '@/shared/codes';
import { audit } from '../audit';
import { need, needBranch, type Ctx } from '../context';
import { lock, withTenant, type Tx } from '../db';
import { AppError, conflict, notFound } from '../errors';
import { addMovements } from './stock';

export const categoryInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(60),
  tracksExpiry: z.boolean().default(false),
  attributes: z.array(attributeDefSchema).max(30),
});

export async function saveCategory(ctx: Ctx, input: z.infer<typeof categoryInput>) {
  need(ctx, 'catalog.manage');
  if (new Set(input.attributes.map((a) => a.key)).size !== input.attributes.length) throw new AppError('Hay atributos repetidos');
  return withTenant(ctx.tenantId, async (tx) => {
    const same = await tx.category.findFirst({ where: { tenantId: ctx.tenantId, name: { equals: input.name, mode: 'insensitive' } } });
    if (same && same.id !== input.id) throw conflict('Ya existe una categoría con ese nombre');
    const data = { name: input.name, tracksExpiry: input.tracksExpiry, attributes: input.attributes };
    if (input.id) {
      const found = await tx.category.findFirst({ where: { tenantId: ctx.tenantId, id: input.id } });
      if (!found) throw notFound('Categoría');
      await tx.category.update({ where: { id: found.id }, data });
      // Activar el control de vencimiento en la categoría lo aplica a sus productos; desactivarlo también.
      if (found.tracksExpiry !== input.tracksExpiry) {
        await tx.product.updateMany({ where: { tenantId: ctx.tenantId, categoryId: found.id }, data: { tracksExpiry: input.tracksExpiry } });
      }
      return { id: found.id };
    }
    const created = await tx.category.create({ data: { ...data, tenantId: ctx.tenantId } });
    return { id: created.id };
  });
}

const money = z.number().min(0).max(10_000_000).multipleOf(0.01);
export const variantInput = z.object({
  id: z.string().optional(),
  sku: z.string().trim().max(60).default(''),
  barcode: z.string().trim().max(60).default(''),
  attributes: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  price: money,
  cost: money.optional(),
  minStock: z.number().min(0).max(1_000_000).multipleOf(0.001).default(0),
  active: z.boolean().default(true),
  initialStock: z.number().min(0).max(1_000_000).multipleOf(0.001).optional(),
  lotCode: z.string().trim().max(60).optional(),
  expiresAt: z.string().date().optional(),
});
export const productInput = z.object({
  id: z.string().optional(),
  categoryId: z.string(),
  name: z.string().trim().min(1).max(150),
  brand: z.string().trim().max(80).default(''),
  description: z.string().trim().max(1000).default(''),
  tracksExpiry: z.boolean().default(false),
  attributes: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  active: z.boolean().default(true),
  /** Sucursal donde se registra el stock inicial. */
  branchId: z.string().optional(),
  variants: z.array(variantInput).min(1).max(200),
});
export type ProductInput = z.infer<typeof productInput>;

async function nextValue(tx: Tx, tenantId: string, key: string) {
  const row = await tx.counter.upsert({
    where: { tenantId_key: { tenantId, key } }, create: { tenantId, key, value: 1 }, update: { value: { increment: 1 } },
  });
  return row.value;
}

/** Genera un código que no choque con los ingresados manualmente. */
async function freshCode(tx: Tx, tenantId: string, field: 'sku' | 'barcode', make: (n: number) => string, reserved: Set<string>) {
  for (let i = 0; i < 1000; i++) {
    const code = make(await nextValue(tx, tenantId, field));
    if (!reserved.has(code) && !(await tx.variant.findFirst({ where: { tenantId, [field]: code }, select: { id: true } }))) return code;
  }
  throw new AppError('No se pudo generar un código único');
}

export async function saveProductTx(tx: Tx, ctx: Ctx, input: ProductInput) {
  const category = await tx.category.findFirst({ where: { tenantId: ctx.tenantId, id: input.categoryId } });
  if (!category) throw notFound('Categoría');
  const defs = category.attributes as unknown as AttributeDef[];
  const own = validateAttributes(defs, input.attributes, false);
  const errors = [...own.errors];
  const variantAttrs = input.variants.map((v, i) => {
    const r = validateAttributes(defs, v.attributes, true);
    errors.push(...r.errors.map((e) => `Variante ${i + 1}: ${e}`));
    return r.values;
  });
  if (errors.length) throw new AppError(errors.join('. '));

  const existing = input.id
    ? await tx.product.findFirst({ where: { tenantId: ctx.tenantId, id: input.id }, include: { variants: true } })
    : null;
  if (input.id && !existing) throw notFound('Producto');
  const data = {
    categoryId: category.id, name: input.name, brand: input.brand, description: input.description,
    tracksExpiry: input.tracksExpiry, attributes: own.values, active: input.active,
  };
  const product = existing
    ? await tx.product.update({ where: { id: existing.id }, data })
    : await tx.product.create({ data: { ...data, tenantId: ctx.tenantId } });

  const reservedSku = new Set(input.variants.map((v) => v.sku).filter(Boolean));
  const reservedBar = new Set(input.variants.map((v) => v.barcode).filter(Boolean));
  if (reservedSku.size !== input.variants.filter((v) => v.sku).length || reservedBar.size !== input.variants.filter((v) => v.barcode).length) {
    throw new AppError('Hay códigos repetidos entre las variantes');
  }
  const ids: string[] = [];
  for (const [i, v] of input.variants.entries()) {
    const current = v.id ? existing?.variants.find((x) => x.id === v.id) : undefined;
    if (v.id && !current) throw notFound('Variante');
    const sku = v.sku || current?.sku || (await freshCode(tx, ctx.tenantId, 'sku', (n) => internalSku(category.name, n), reservedSku));
    const barcode = v.barcode || current?.barcode || (await freshCode(tx, ctx.tenantId, 'barcode', internalBarcode, reservedBar));
    const clash = await tx.variant.findFirst({
      where: { tenantId: ctx.tenantId, OR: [{ sku }, { barcode }], ...(current ? { id: { not: current.id } } : {}) },
    });
    if (clash) throw conflict(`El código ${clash.sku === sku ? sku : barcode} ya está en uso`);
    const priceChanged = current && Number(current.price) !== v.price;
    if (priceChanged) need(ctx, 'prices.manage');
    const row = { sku, barcode, attributes: variantAttrs[i], price: v.price, minStock: v.minStock, active: v.active, ...(v.cost !== undefined ? { cost: v.cost } : {}) };
    const saved = current
      ? await tx.variant.update({ where: { id: current.id }, data: row })
      : await tx.variant.create({ data: { ...row, tenantId: ctx.tenantId, productId: product.id } });
    ids.push(saved.id);
    if (!current || priceChanged) {
      await tx.priceHistory.create({ data: { tenantId: ctx.tenantId, variantId: saved.id, price: v.price, changedBy: ctx.userId } });
    }
    if (priceChanged) await audit(tx, ctx, 'price.change', 'Variant', saved.id, { from: Number(current.price), to: v.price, sku });

    if (!current && v.initialStock) {
      need(ctx, 'stock.in');
      if (!input.branchId) throw new AppError('Indica la sucursal del stock inicial');
      needBranch(ctx, input.branchId);
      let lotId: string | null = null;
      if (input.tracksExpiry && !v.expiresAt) throw new AppError('Indica la fecha de vencimiento del stock inicial');
      if (v.expiresAt || v.lotCode) {
        const lot = await tx.lot.create({
          data: { tenantId: ctx.tenantId, variantId: saved.id, code: v.lotCode || `V-${v.expiresAt}`, expiresAt: v.expiresAt ? new Date(`${v.expiresAt}T00:00:00Z`) : null },
        });
        lotId = lot.id;
      }
      await addMovements(tx, ctx, [{
        branchId: input.branchId, variantId: saved.id, lotId, type: 'INITIAL', quantity: v.initialStock,
        unitCost: v.cost ?? 0, reason: 'Stock inicial', refType: 'product', refId: product.id, occurredAt: new Date(),
      }]);
    }
  }
  return { id: product.id, variantIds: ids };
}

export async function saveProduct(ctx: Ctx, input: ProductInput) {
  need(ctx, 'catalog.manage');
  return withTenant(ctx.tenantId, async (tx) => {
    await lock(tx, `catalog:${ctx.tenantId}`);
    return saveProductTx(tx, ctx, input);
  }, { timeout: 60_000 });
}
