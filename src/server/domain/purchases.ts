import { normalizeDocumentNumber, type PurchaseRef } from '@/shared/purchase';
import { need, needBranch, type Ctx } from '../context';
import { withTenant, type Tx } from '../db';
import { notFound } from '../errors';

export interface DocumentKey { supplierRuc: string; docType: string; series: string; number: string }

/** Busca un comprobante del proveedor ya ingresado en cualquier sucursal del negocio. */
export async function findPurchase(tx: Tx, ctx: Ctx, key: DocumentKey): Promise<PurchaseRef | null> {
  const { series, number } = normalizeDocumentNumber(key.series, key.number);
  if (!key.supplierRuc || !key.docType || !series || !number) return null;
  const found = await tx.purchaseDocument.findFirst({
    where: { tenantId: ctx.tenantId, supplierRuc: key.supplierRuc, docType: key.docType, series, number },
  });
  if (!found) return null;
  const branch = await tx.branch.findFirst({ where: { tenantId: ctx.tenantId, id: found.branchId } });
  return { createdAt: found.createdAt.toISOString(), branch: branch?.name ?? '', total: Number(found.total) };
}

export async function checkPurchase(ctx: Ctx, key: DocumentKey) {
  need(ctx, 'stock.in');
  return withTenant(ctx.tenantId, async (tx) => ({ duplicate: await findPurchase(tx, ctx, key) }));
}

/** Archivo original de un comprobante escaneado. */
export async function purchaseFile(ctx: Ctx, id: string) {
  need(ctx, 'stock.in');
  return withTenant(ctx.tenantId, async (tx) => {
    const scan = await tx.purchaseScan.findFirst({ where: { tenantId: ctx.tenantId, id } });
    if (!scan) throw notFound('Comprobante');
    needBranch(ctx, scan.branchId);
    return { data: Buffer.from(scan.data), mimeType: scan.mimeType, fileName: scan.fileName };
  });
}
