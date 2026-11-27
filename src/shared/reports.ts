export const REPORTS = {
  sales_period: 'Ventas por día', sales_branch: 'Ventas por sucursal', sales_seller: 'Ventas por vendedor', sales_product: 'Ventas por producto',
  valuation: 'Valorización de inventario', rotation: 'Rotación de inventario', no_movement: 'Productos sin movimiento',
  waste_expired: 'Mermas y vencidos', cash_closes: 'Cierres de caja',
} as const;
export type ReportType = keyof typeof REPORTS;
export interface ReportColumn { key: string; label: string; kind?: 'money' | 'number' | 'text' }
export interface Report { title: string; subtitle: string; columns: ReportColumn[]; rows: Record<string, string | number>[]; totals?: Record<string, string | number> }
