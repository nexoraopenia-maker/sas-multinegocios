/**
 * Toda mutación de stock, ventas y caja es una "operación" con id único (clave de idempotencia).
 * Con o sin internet se usa el mismo formato y el mismo procesamiento en el servidor.
 */
import { z } from 'zod';

const id = z.string().uuid();
const ref = z.string().min(1).max(64);
const qty = z.number().positive().max(1_000_000).multipleOf(0.001);
const amount = z.number().min(0).max(10_000_000).multipleOf(0.01);
const text = z.string().trim().max(300);
const reason = z.string().trim().min(3, 'Indica el motivo').max(300);
export const paymentMethod = z.enum(['CASH', 'YAPE', 'PLIN', 'CARD', 'TRANSFER', 'VOUCHER']);
export type PaymentMethodT = z.infer<typeof paymentMethod>;
export const PAYMENT_LABELS: Record<PaymentMethodT, string> = {
  CASH: 'Efectivo', YAPE: 'Yape', PLIN: 'Plin', CARD: 'Tarjeta', TRANSFER: 'Transferencia', VOUCHER: 'Vale',
};

export const payloads = {
  'sale.create': z.object({
    saleId: id, branchId: ref, series: z.string().min(1).max(20), number: z.number().int().positive(),
    cashSessionId: id.nullish(),
    customer: z.object({ id, name: z.string().trim().min(1).max(120), docNumber: text.default(''), phone: text.default(''), email: text.default('') }).nullish(),
    customerId: ref.nullish(),
    items: z.array(z.object({ variantId: ref, quantity: qty, unitPrice: amount, discount: amount.default(0), lotId: ref.nullish() })).min(1).max(200),
    payments: z.array(z.object({ method: paymentMethod, amount, reference: text.default('') })).max(10),
  }),
  'sale.void': z.object({ saleId: ref, reason, cashSessionId: id.nullish() }),
  'sale.return': z.object({
    returnId: id, saleId: ref, reason, refundMethod: paymentMethod, cashSessionId: id.nullish(),
    items: z.array(z.object({ saleItemId: ref, quantity: qty, restock: z.boolean().default(true) })).min(1).max(200),
  }),
  'stock.in': z.object({
    branchId: ref, reason: text.default('Ingreso de mercadería'), initial: z.boolean().default(false),
    /** Comprobante escaneado que respalda el ingreso. */
    scanId: ref.nullish(),
    document: z.object({ supplierRuc: z.string().regex(/^\d{11}$/), docType: z.string().max(2), series: z.string().max(10), number: z.string().max(12), total: amount, igv: amount.default(0), issueDate: z.string().max(10).default('') }).nullish(),
    items: z.array(z.object({ variantId: ref, quantity: qty, unitCost: amount.nullish(), lotCode: z.string().trim().max(60).nullish(), expiresAt: z.string().date().nullish() })).min(1).max(500),
  }),
  'adjustment.request': z.object({
    adjustmentId: id, branchId: ref, kind: z.enum(['ADJUSTMENT', 'WASTE', 'COUNT']), reason,
    items: z.array(z.object({
      variantId: ref, lotId: ref.nullish(),
      delta: z.number().min(-1_000_000).max(1_000_000).multipleOf(0.001),
      expectedQty: z.number().nullish(), countedQty: z.number().min(0).nullish(),
    })).min(1).max(1000),
  }),
  'adjustment.review': z.object({ adjustmentId: ref, approve: z.boolean() }),
  'transfer.request': z.object({
    transferId: id, fromBranchId: ref, toBranchId: ref, notes: text.default(''),
    items: z.array(z.object({ variantId: ref, quantity: qty })).min(1).max(300),
  }),
  'transfer.review': z.object({ transferId: ref, approve: z.boolean() }),
  'transfer.cancel': z.object({ transferId: ref }),
  'transfer.ship': z.object({ transferId: ref, items: z.array(z.object({ variantId: ref, quantity: z.number().min(0).multipleOf(0.001) })).min(1).max(300) }),
  'transfer.receive': z.object({ transferId: ref, items: z.array(z.object({ variantId: ref, quantity: z.number().min(0).multipleOf(0.001) })).min(1).max(300) }),
  'cash.open': z.object({ cashSessionId: id, branchId: ref, openingAmount: amount }),
  'cash.movement': z.object({ cashSessionId: ref, type: z.enum(['IN', 'OUT']), amount: amount.positive(), reason }),
  'cash.close': z.object({
    cashSessionId: ref, notes: text.default(''),
    counted: z.object({ CASH: amount, YAPE: amount.default(0), PLIN: amount.default(0), CARD: amount.default(0), TRANSFER: amount.default(0) }),
  }),
} as const;

export type OperationType = keyof typeof payloads;
export type Payload<T extends OperationType> = z.infer<(typeof payloads)[T]>;

export const operationSchema = z.object({
  id,
  type: z.enum(Object.keys(payloads) as [OperationType, ...OperationType[]]),
  clientTime: z.string().datetime(),
  payload: z.unknown(),
});
export type Operation = z.infer<typeof operationSchema>;

export const OPERATION_LABELS: Record<OperationType, string> = {
  'sale.create': 'Venta', 'sale.void': 'Anulación', 'sale.return': 'Devolución', 'stock.in': 'Ingreso de mercadería',
  'adjustment.request': 'Solicitud de ajuste', 'adjustment.review': 'Revisión de ajuste',
  'transfer.request': 'Solicitud de traslado', 'transfer.review': 'Aprobación de traslado', 'transfer.cancel': 'Cancelación de traslado',
  'transfer.ship': 'Envío de traslado', 'transfer.receive': 'Recepción de traslado',
  'cash.open': 'Apertura de caja', 'cash.movement': 'Movimiento de caja', 'cash.close': 'Cierre de caja',
};
