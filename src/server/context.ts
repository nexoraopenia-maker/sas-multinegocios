import type { Features } from '@/shared/features';
import type { Permission, Role } from '@/shared/permissions';
import { AppError, forbidden } from './errors';

/** Identidad y alcance de quien actúa, construidos en el servidor a partir de la sesión. */
export interface Ctx {
  tenantId: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  permissions: Set<Permission>;
  branchIds: string[];
  features: Features;
}

export function need(ctx: Ctx, permission: Permission) {
  if (!ctx.permissions.has(permission)) throw forbidden();
}

export function needBranch(ctx: Ctx, branchId: string) {
  if (!ctx.branchIds.includes(branchId)) throw forbidden('No tienes acceso a esa sucursal');
}

export function needFeature(ctx: Ctx, feature: 'multiBranch' | 'aiAgent' | 'sunat') {
  if (!ctx.features[feature]) throw new AppError('Esta función no está habilitada para tu cuenta', 403, 'FEATURE_DISABLED');
}
