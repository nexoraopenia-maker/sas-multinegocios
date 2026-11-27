import type { Prisma } from '@/generated/prisma/client';
import type { Tx } from './db';

export async function audit(
  tx: Tx,
  actor: { tenantId?: string | null; userId?: string | null; email: string },
  action: string,
  entity: string,
  entityId?: string,
  data?: unknown,
) {
  await tx.auditLog.create({
    data: {
      tenantId: actor.tenantId ?? null, actorId: actor.userId ?? null, actorEmail: actor.email,
      action, entity, entityId: entityId ?? null, data: data === undefined ? undefined : (data as Prisma.InputJsonValue),
    },
  });
}
