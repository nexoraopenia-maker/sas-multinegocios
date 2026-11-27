/** Datos que el dispositivo guarda en IndexedDB para operar sin internet. */
import type { AttributeDef, AttributeValues } from './attributes';
import type { Features } from './features';
import type { Permission, Role } from './permissions';

export interface SessionUser {
  id: string; name: string; email: string; role: Role; tenantId: string; tenantName: string;
  permissions: Permission[]; branchIds: string[]; features: Features; mustChangePassword: boolean; sessionExpiresAt: string;
}
export interface BranchDto { id: string; code: string; name: string; address: string; active: boolean }
export interface CategoryDto { id: string; name: string; tracksExpiry: boolean; attributes: AttributeDef[] }
export interface ProductDto { id: string; categoryId: string; name: string; brand: string; description: string; tracksExpiry: boolean; attributes: AttributeValues; active: boolean }
export interface VariantDto { id: string; productId: string; sku: string; barcode: string; attributes: AttributeValues; price: number; cost: number | null; minStock: number; active: boolean }
export interface LotDto { id: string; variantId: string; code: string; expiresAt: string | null }
export interface BalanceDto { branchId: string; variantId: string; lotId: string | null; quantity: number }
export interface CustomerDto { id: string; name: string; docNumber: string; phone: string; email: string }
export interface SettingsDto {
  currency: string; legalName: string; taxId: string; ticketFooter: string; expiryDaysAhead: number;
  alertExpiredEnabled: boolean; alertExpiringEnabled: boolean; alertLowStockEnabled: boolean;
  maxSellerDiscountPct: number; labelFormat: LabelFormat;
}
export interface LabelFormat { widthMm: number; heightMm: number; columns: number; symbol: 'code128' | 'ean13' | 'qrcode'; showName: boolean; showPrice: boolean; showSku: boolean }
export const DEFAULT_LABEL: LabelFormat = { widthMm: 50, heightMm: 30, columns: 3, symbol: 'code128', showName: true, showPrice: true, showSku: true };
export interface CashSessionDto { id: string; branchId: string; deviceKey: string; userId: string; openedAt: string; openingAmount: number }
export interface TransferDto {
  id: string; fromBranchId: string; toBranchId: string; status: 'REQUESTED' | 'APPROVED' | 'SHIPPED' | 'RECEIVED' | 'REJECTED' | 'CANCELLED';
  notes: string; requestedAt: string; items: { variantId: string; requested: number; shipped: number; received: number }[];
}
export interface AdjustmentDto {
  id: string; branchId: string; kind: 'ADJUSTMENT' | 'WASTE' | 'COUNT'; status: 'PENDING' | 'APPROVED' | 'REJECTED'; reason: string; requestedAt: string; requestedByName: string;
  items: { variantId: string; lotId: string | null; delta: number; expectedQty?: number | null; countedQty?: number | null }[];
}
export interface DeviceDto { deviceKey: string; branchId: string; series: string; lastNumber: number }

export interface Snapshot {
  takenAt: string; branchId: string; settings: SettingsDto; branches: BranchDto[]; categories: CategoryDto[];
  products: ProductDto[]; variants: VariantDto[]; lots: LotDto[]; balances: BalanceDto[]; customers: CustomerDto[];
  cashSession: CashSessionDto | null; transfers: TransferDto[]; adjustments: AdjustmentDto[]; openNotices: number;
}

export function variantLabel(product: { name: string }, variant: { attributes: AttributeValues }): string {
  const parts = Object.values(variant.attributes ?? {}).join(' / ');
  return parts ? `${product.name} · ${parts}` : product.name;
}

export function alertSwitches(features: Features, s: SettingsDto) {
  return {
    expired: features.alertExpiry && s.alertExpiredEnabled,
    expiring: features.alertExpiry && s.alertExpiringEnabled,
    lowStock: features.alertLowStock && s.alertLowStockEnabled,
    daysAhead: s.expiryDaysAhead,
  };
}
