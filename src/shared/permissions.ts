export type Role = 'SUPERADMIN' | 'ADMIN' | 'SUPERVISOR' | 'SELLER';
export type BusinessRole = Exclude<Role, 'SUPERADMIN'>;

export const PERMISSIONS = [
  'settings.manage', 'branches.manage', 'users.manage', 'prices.manage',
  'catalog.view', 'catalog.manage', 'cost.view',
  'stock.in', 'stock.adjust.request', 'stock.adjust.approve',
  'transfer.request', 'transfer.approve', 'transfer.operate',
  'pos.sell', 'pos.discount', 'sale.void', 'sale.return',
  'cash.operate', 'cash.review',
  'reports.view', 'alerts.view', 'agent.use', 'notices.review',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const SELLER: Permission[] = ['catalog.view', 'pos.sell', 'cash.operate', 'alerts.view', 'agent.use'];

const SUPERVISOR: Permission[] = [
  ...SELLER, 'catalog.manage', 'cost.view', 'stock.in', 'stock.adjust.request', 'stock.adjust.approve',
  'transfer.request', 'transfer.approve', 'transfer.operate', 'pos.discount', 'sale.void', 'sale.return',
  'cash.review', 'reports.view', 'notices.review',
];

export const ROLE_PERMISSIONS: Record<BusinessRole, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  SUPERVISOR,
  SELLER,
};

/** Permisos que el administrador puede conceder individualmente a un vendedor. */
export const GRANTABLE: Permission[] = [
  'stock.in', 'stock.adjust.request', 'transfer.request', 'transfer.operate', 'pos.discount',
];

export function permissionsFor(role: Role, extra: string[] = []): Permission[] {
  if (role === 'SUPERADMIN') return [];
  const set = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const p of extra) if ((GRANTABLE as string[]).includes(p)) set.add(p as Permission);
  return [...set];
}

export const ROLE_LABELS: Record<Role, string> = {
  SUPERADMIN: 'SuperAdmin', ADMIN: 'Administrador', SUPERVISOR: 'Supervisor', SELLER: 'Vendedor',
};
