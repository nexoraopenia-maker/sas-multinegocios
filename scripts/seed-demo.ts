/**
 * Crea (o completa) la cuenta de demostración con productos de ejemplo.
 *
 * Es idempotente: se puede ejecutar varias veces; solo agrega lo que falte y nunca modifica
 * productos, stock ni contraseñas ya existentes. Usa la misma lógica de dominio que la aplicación
 * (rol saas_app y RLS), sin escribir directamente en las tablas de negocio.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AuthInfo } from '../src/server/auth';
import type { Ctx } from '../src/server/context';
import { disconnect, lock, withPlatform, withTenant } from '../src/server/db';
import { productInput, saveCategory, saveProductTx } from '../src/server/domain/catalog';
import { processOperation } from '../src/server/domain/sync';
import { createAccount } from '../src/server/platform';
import { categoryTemplates, type AttributeValues } from '../src/shared/attributes';
import { parseFeatures } from '../src/shared/features';
import { permissionsFor } from '../src/shared/permissions';
import { addDays, todayISO } from '../src/shared/stock';

export const DEMO_BUSINESS = 'Tienda Demo';
export const DEMO_EMAIL = 'demo@tienda-demo.example';

interface DemoVariant {
  sku: string; attributes?: AttributeValues; price: number; cost: number; stock: number; min?: number;
  /** Días desde hoy hasta el vencimiento del stock inicial (negativo = ya vencido). */
  expiresIn?: number;
  /** Segundo lote, para probar la venta por orden de vencimiento (FEFO). */
  extraLot?: { expiresIn: number; stock: number };
}
interface DemoProduct { category: string; name: string; attributes?: AttributeValues; variants: DemoVariant[] }

const PRODUCTS: DemoProduct[] = [
  { category: 'Ropa', name: 'Polo básico de algodón', attributes: { material: 'Algodón' }, variants: [
    { sku: 'DEMO-POL-S', attributes: { talla: 'S', color: 'Negro' }, price: 35, cost: 18, stock: 12, min: 3 },
    { sku: 'DEMO-POL-M', attributes: { talla: 'M', color: 'Negro' }, price: 35, cost: 18, stock: 20, min: 3 },
    { sku: 'DEMO-POL-L', attributes: { talla: 'L', color: 'Blanco' }, price: 35, cost: 18, stock: 8, min: 3 },
  ] },
  { category: 'Ropa', name: 'Jean slim', attributes: { material: 'Denim' }, variants: [
    { sku: 'DEMO-JEA-30', attributes: { talla: '30', color: 'Azul' }, price: 89.9, cost: 48, stock: 6, min: 2 },
    { sku: 'DEMO-JEA-32', attributes: { talla: '32', color: 'Azul' }, price: 89.9, cost: 48, stock: 9, min: 2 },
  ] },
  { category: 'Ropa', name: 'Casaca cortaviento', variants: [
    { sku: 'DEMO-CAS-M', attributes: { talla: 'M', color: 'Verde' }, price: 129, cost: 70, stock: 1, min: 3 },
  ] },
  { category: 'Zapatillas', name: 'Zapatilla urbana', variants: [
    { sku: 'DEMO-ZAP-38', attributes: { talla: '38', color: 'Blanco', modelo: 'Urban' }, price: 159, cost: 90, stock: 5, min: 2 },
    { sku: 'DEMO-ZAP-40', attributes: { talla: '40', color: 'Blanco', modelo: 'Urban' }, price: 159, cost: 90, stock: 7, min: 2 },
    { sku: 'DEMO-ZAP-42', attributes: { talla: '42', color: 'Negro', modelo: 'Urban' }, price: 159, cost: 90, stock: 2, min: 2 },
  ] },
  { category: 'Joyas', name: 'Anillo de plata 925', attributes: { material: 'Plata' }, variants: [
    { sku: 'DEMO-ANI-6', attributes: { talla: '6', kilates: '925', peso_g: 3.2 }, price: 75, cost: 35, stock: 4, min: 1 },
    { sku: 'DEMO-ANI-7', attributes: { talla: '7', kilates: '925', peso_g: 3.5 }, price: 75, cost: 35, stock: 4, min: 1 },
  ] },
  { category: 'Joyas', name: 'Cadena de oro', attributes: { material: 'Oro' }, variants: [
    { sku: 'DEMO-CAD-18K', attributes: { kilates: '18k', peso_g: 6.8 }, price: 1850, cost: 1400, stock: 2 },
  ] },
  { category: 'Alimentos y bebidas', name: 'Chocolate bitter', variants: [
    { sku: 'DEMO-CHO-100', attributes: { presentacion: 'Tableta 100 g', sabor: 'Cacao 70%' }, price: 12.5, cost: 7, stock: 10, min: 5, expiresIn: 15, extraLot: { expiresIn: 180, stock: 24 } },
  ] },
  { category: 'Alimentos y bebidas', name: 'Galletas de avena', variants: [
    { sku: 'DEMO-GAL-200', attributes: { presentacion: 'Paquete 200 g' }, price: 6.5, cost: 3.5, stock: 6, min: 4, expiresIn: -5 },
  ] },
  { category: 'Alimentos y bebidas', name: 'Bebida energética', variants: [
    { sku: 'DEMO-BEB-473', attributes: { presentacion: 'Lata 473 ml' }, price: 7, cost: 4.2, stock: 48, min: 12, expiresIn: 240 },
  ] },
  { category: 'Alimentos y bebidas', name: 'Agua mineral', variants: [
    { sku: 'DEMO-AGU-625', attributes: { presentacion: 'Botella 625 ml' }, price: 2.5, cost: 1.1, stock: 4, min: 12, expiresIn: 300 },
  ] },
  { category: 'General', name: 'Bolsa de regalo', variants: [
    { sku: 'DEMO-BOL-M', attributes: { presentacion: 'Mediana' }, price: 4, cost: 1.5, stock: 30, min: 10 },
  ] },
];

/** SuperAdmin que figura como autor del alta en la auditoría. Debe haber cambiado su contraseña inicial. */
async function superAdminActor(): Promise<AuthInfo> {
  const user = await withPlatform((tx) => tx.user.findFirst({
    where: { role: 'SUPERADMIN', active: true, mustChangePassword: false }, orderBy: { createdAt: 'asc' },
  }));
  if (!user) {
    throw new Error('No hay un SuperAdmin listo. Ejecuta "npm run superadmin:create", ingresa una vez en /login y cambia su contraseña.');
  }
  return {
    userId: user.id, email: user.email, name: user.name, role: 'SUPERADMIN', tenantId: null,
    mustChangePassword: user.mustChangePassword, sessionExpiresAt: new Date(Date.now() + 60_000), ctx: null, tenantName: '',
  };
}

/** Devuelve la cuenta demo, creándola si no existe. Nunca reutiliza una cuenta que no sea la demo. */
async function ensureAccount(email: string, password: string | undefined) {
  const find = () => withPlatform(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    const tenant = user?.tenantId ? await tx.tenant.findUnique({ where: { id: user.tenantId } }) : null;
    return { user, tenant };
  });
  let found = await find();
  let newPassword: string | null = null;
  if (!found.user) {
    newPassword = password || `Demo-${randomBytes(9).toString('base64url')}-7`;
    await createAccount(await superAdminActor(), {
      businessName: DEMO_BUSINESS, businessType: 'mixta', adminName: 'Administrador Demo', email, password: newPassword,
    });
    found = await find();
  }
  const { user, tenant } = found;
  if (!user || !tenant || user.role !== 'ADMIN' || tenant.name !== DEMO_BUSINESS) {
    throw new Error(`El correo ${email} pertenece a un usuario que no es el administrador de "${DEMO_BUSINESS}". No se modificó nada; usa otro DEMO_ADMIN_EMAIL.`);
  }
  if (tenant.status !== 'ACTIVE') throw new Error('La cuenta demo está suspendida o eliminada. Reactívala o usa otro DEMO_ADMIN_EMAIL.');
  return { user, tenant, newPassword };
}

export async function seedDemo(options: { email?: string; password?: string } = {}) {
  const email = (options.email || DEMO_EMAIL).trim().toLowerCase();
  const { user, tenant, newPassword } = await ensureAccount(email, options.password);
  const tenantId = tenant.id;

  const { branch, existing } = await withTenant(tenantId, async (tx) => ({
    branch: await tx.branch.findFirst({ where: { tenantId, active: true }, orderBy: { code: 'asc' } }),
    existing: await tx.category.findMany({ where: { tenantId } }),
  }));
  if (!branch) throw new Error('La cuenta demo no tiene una sucursal activa');

  // El tenantId sale de la base de datos (la cuenta demo verificada arriba), nunca de un parámetro.
  const ctx: Ctx = {
    tenantId, userId: user.id, name: user.name, email: user.email, role: 'ADMIN',
    permissions: new Set(permissionsFor('ADMIN')), branchIds: [branch.id], features: parseFeatures(tenant.features),
  };

  const categoryIds = new Map(existing.map((c) => [c.name, c.id]));
  const templates = [...categoryTemplates('mixta'), ...categoryTemplates('zapatillas'), ...categoryTemplates('joyeria')];
  for (const name of new Set(PRODUCTS.map((p) => p.category))) {
    if (categoryIds.has(name)) continue;
    const template = templates.find((t) => t.name === name)!;
    categoryIds.set(name, (await saveCategory(ctx, template)).id);
  }

  const today = todayISO();
  const date = (days: number) => addDays(today, days);
  let created = 0;
  for (const p of PRODUCTS) {
    const tracksExpiry = p.variants.some((v) => v.expiresIn !== undefined);
    created += await withTenant(tenantId, async (tx) => {
      await lock(tx, `catalog:${tenantId}`);
      if (await tx.variant.findFirst({ where: { tenantId, sku: { in: p.variants.map((v) => v.sku) } } })) return 0;
      await saveProductTx(tx, ctx, productInput.parse({
        categoryId: categoryIds.get(p.category), name: p.name, brand: 'Demo', description: 'Producto de ejemplo',
        tracksExpiry, attributes: p.attributes ?? {}, branchId: branch.id,
        variants: p.variants.map((v) => ({
          sku: v.sku, attributes: v.attributes ?? {}, price: v.price, cost: v.cost, minStock: v.min ?? 0, initialStock: v.stock,
          ...(v.expiresIn !== undefined ? { expiresAt: date(v.expiresIn), lotCode: 'DEMO-L1' } : {}),
        })),
      }));
      return 1;
    }, { timeout: 60_000 });

    for (const v of p.variants) {
      if (!v.extraLot) continue;
      const pending = await withTenant(tenantId, async (tx) => {
        const variant = await tx.variant.findFirst({ where: { tenantId, sku: v.sku } });
        if (!variant) return null;
        const lot = await tx.lot.findFirst({ where: { tenantId, variantId: variant.id, code: 'DEMO-L2' } });
        return lot ? null : variant.id;
      });
      if (!pending) continue;
      const result = await processOperation(ctx, 'seed-demo', {
        id: randomUUID(), type: 'stock.in', clientTime: new Date().toISOString(),
        payload: {
          branchId: branch.id, reason: 'Segundo lote de demostración',
          items: [{ variantId: pending, quantity: v.extraLot.stock, lotCode: 'DEMO-L2', expiresAt: date(v.extraLot.expiresIn) }],
        },
      });
      if (result.status !== 'APPLIED') throw new Error(result.error);
    }
  }

  const totals = await withTenant(tenantId, async (tx) => ({
    products: await tx.product.count({ where: { tenantId } }),
    variants: await tx.variant.count({ where: { tenantId } }),
  }));
  return { tenantId, branchId: branch.id, email, newPassword, mustChangePassword: user.mustChangePassword, created, ...totals };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f);
  try {
    if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL (ver .env.example)');
    const url = new URL(process.env.DATABASE_URL);
    console.log(`Base de datos: ${url.host}${url.pathname}`);
    const r = await seedDemo({ email: process.env.DEMO_ADMIN_EMAIL, password: process.env.DEMO_ADMIN_PASSWORD });
    console.log(`\n"${DEMO_BUSINESS}" lista: ${r.products} productos, ${r.variants} variantes (${r.created} productos creados ahora).`);
    console.log(`Usuario: ${r.email}`);
    if (!r.newPassword) console.log('Contraseña: la cuenta ya existía y no se cambió. Si la olvidaste, restablécela en SuperAdmin > Cuentas.');
    else if (process.env.DEMO_ADMIN_PASSWORD) console.log('Contraseña: la definida en DEMO_ADMIN_PASSWORD (se pedirá cambiarla al ingresar).');
    else console.log(`Contraseña temporal (solo se muestra ahora): ${r.newPassword}\nSe pedirá cambiarla al ingresar.`);
  } catch (e) {
    console.error(`\nNo se pudo preparar la cuenta demo: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  } finally {
    await disconnect();
  }
}
