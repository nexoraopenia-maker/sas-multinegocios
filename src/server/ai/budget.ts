import type { Features } from '@/shared/features';
import { parseFeatures } from '@/shared/features';
import { lock, withPlatform, withTenant } from '../db';
import { AppError } from '../errors';

export interface Price { inputPerMTok: number; outputPerMTok: number }

export const costUsd = (price: Price, inputTokens: number, outputTokens: number) =>
  (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;

export interface Spent { usd: number; tokens: number }

/**
 * Cuántos tokens de salida se pueden autorizar sin pasar el límite, suponiendo el peor caso.
 * Devuelve 0 si no alcanza para una respuesta útil.
 */
export function affordableOutput(features: Pick<Features, 'aiLimitType' | 'aiLimitValue'>, spent: Spent, price: Price, inputTokens: number, wanted: number, minimum = 300) {
  const remaining = features.aiLimitValue - (features.aiLimitType === 'USD' ? spent.usd : spent.tokens);
  const max = features.aiLimitType === 'USD'
    ? price.outputPerMTok > 0 ? Math.floor(((remaining - costUsd(price, inputTokens, 0)) * 1_000_000) / price.outputPerMTok) : wanted
    : Math.floor(remaining - inputTokens);
  const allowed = Math.min(wanted, max);
  return allowed >= minimum ? allowed : 0;
}

export async function spentSince(tenantId: string, since: Date): Promise<Spent> {
  return withTenant(tenantId, async (tx) => {
    const sum = await tx.aiUsage.aggregate({ where: { tenantId, createdAt: { gte: since } }, _sum: { costUsd: true, inputTokens: true, outputTokens: true } });
    return { usd: Number(sum._sum.costUsd ?? 0), tokens: (sum._sum.inputTokens ?? 0) + (sum._sum.outputTokens ?? 0) };
  });
}

export const LIMIT_MESSAGE = 'Se alcanzó el límite de consumo del agente de IA de tu negocio. Pide al proveedor que lo amplíe.';

/**
 * Reserva el costo máximo de una llamada ANTES de hacerla. La suma y la reserva ocurren bajo un
 * bloqueo por negocio, de modo que consultas simultáneas no pueden superar el límite.
 */
export async function reserve(input: { tenantId: string; userId: string; model: string; question: string; price: Price; inputTokens: number; maxOutput: number; minOutput?: number }) {
  // Estado actual (el SuperAdmin pudo cambiar el límite o apagar el módulo).
  const tenant = await withPlatform((tx) => tx.tenant.findUniqueOrThrow({ where: { id: input.tenantId } }));
  const features = parseFeatures(tenant.features);
  if (!features.aiAgent || tenant.status !== 'ACTIVE') throw new AppError('El agente de IA no está habilitado para tu cuenta', 403, 'FEATURE_DISABLED');
  return withTenant(input.tenantId, async (tx) => {
    await lock(tx, `ai:${input.tenantId}`);
    const sum = await tx.aiUsage.aggregate({ where: { tenantId: input.tenantId, createdAt: { gte: tenant.aiUsageResetAt } }, _sum: { costUsd: true, inputTokens: true, outputTokens: true } });
    const spent = { usd: Number(sum._sum.costUsd ?? 0), tokens: (sum._sum.inputTokens ?? 0) + (sum._sum.outputTokens ?? 0) };
    const maxTokens = affordableOutput(features, spent, input.price, input.inputTokens, input.maxOutput, input.minOutput);
    if (!maxTokens) return null;
    const row = await tx.aiUsage.create({
      data: {
        tenantId: input.tenantId, userId: input.userId, model: input.model, question: input.question.slice(0, 500), status: 'RESERVED',
        inputTokens: input.inputTokens, outputTokens: maxTokens, costUsd: costUsd(input.price, input.inputTokens, maxTokens),
      },
    });
    return { id: row.id, maxTokens };
  });
}

/** Sustituye la reserva por el consumo real. */
export async function settle(tenantId: string, id: string, actual: { model: string; inputTokens: number; outputTokens: number; costUsd: number; status: 'OK' | 'ERROR' }) {
  await withTenant(tenantId, (tx) => tx.aiUsage.update({ where: { id }, data: actual }));
}

export async function recordBlocked(tenantId: string, userId: string, model: string, question: string) {
  await withTenant(tenantId, async (tx) => {
    await lock(tx, `ai:${tenantId}`);
    await tx.aiUsage.create({ data: { tenantId, userId, model, question: question.slice(0, 500), status: 'BLOCKED' } });
    const open = await tx.supervisorNotice.findFirst({ where: { tenantId, type: 'AI_LIMIT', resolvedAt: null } });
    if (!open) await tx.supervisorNotice.create({ data: { tenantId, type: 'AI_LIMIT', message: LIMIT_MESSAGE } });
  });
}
