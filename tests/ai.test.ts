import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { askAgent, REFUSAL_MESSAGE, RETRY_MESSAGE, type ModelClient } from '@/server/ai/agent';
import { affordableOutput, costUsd, spentSince } from '@/server/ai/budget';
import { runTool } from '@/server/ai/tools';
import { authenticate } from '@/server/auth';
import { disconnect, withTenant } from '@/server/db';
import { resetAiUsage, updateFeatures } from '@/server/platform';
import { parseFeatures } from '@/shared/features';
import { makeBusiness, makeProduct, type Business } from './helpers';

const price = { inputPerMTok: 4, outputPerMTok: 20 };
/** Precio sembrado del modelo por defecto. */
const haiku = { inputPerMTok: 0.1, outputPerMTok: 0.5 };

function fakeClient(options: { outputTokens?: number; useTool?: boolean } = {}) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: ModelClient = {
    countTokens: async () => ({ input_tokens: 1000 }),
    create: async (params) => {
      calls.push(structuredClone(params));
      const tool = options.useTool && calls.length === 1;
      return {
        id: 'msg', type: 'message', role: 'assistant', model: params.model,
        stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null,
        content: tool ? [{ type: 'tool_use', id: 't1', name: 'buscar_stock', input: { texto: '', sucursal: '' } }] : [{ type: 'text', text: 'Hay stock.', citations: null }],
        usage: { input_tokens: 1000, output_tokens: Math.min(options.outputTokens ?? 500, params.max_tokens) },
      } as unknown as Anthropic.Message;
    },
  };
  return { client, calls };
}

describe('agente de IA: solo lectura y límite de consumo', () => {
  let a: Business, other: Business;
  const ctxOf = async (b: Business) => (await authenticate(b.adminAuth.token)).ctx!;
  const limit = (type: 'USD' | 'TOKENS', value: number) => updateFeatures(a.root, a.tenantId, parseFeatures({ aiAgent: true, aiLimitType: type, aiLimitValue: value }));
  beforeAll(async () => {
    a = await makeBusiness();
    other = await makeBusiness();
    await makeProduct(a, { name: 'Polo propio' });
    await makeProduct(other, { name: 'Polo ajeno secreto' });
  });
  afterAll(disconnect);

  it('calcula costo y salida permitida', () => {
    expect(costUsd(price, 1_000_000, 1_000_000)).toBe(24);
    expect(affordableOutput({ aiLimitType: 'USD', aiLimitValue: 1 }, { usd: 0, tokens: 0 }, price, 1000, 4000)).toBe(4000);
    expect(affordableOutput({ aiLimitType: 'USD', aiLimitValue: 1 }, { usd: 0.999, tokens: 0 }, price, 1000, 4000)).toBe(0);
    expect(affordableOutput({ aiLimitType: 'TOKENS', aiLimitValue: 3000 }, { usd: 0, tokens: 500 }, price, 1000, 4000)).toBe(1500);
  });

  it('está apagado por defecto', async () => {
    await expect(askAgent(await ctxOf(a), 'stock', fakeClient().client)).rejects.toThrow('no está habilitada');
  });

  it('las herramientas solo ven el propio negocio y no pueden escribir', async () => {
    await limit('USD', 1);
    const ctx = await ctxOf(a);
    const r = await runTool(ctx, 'buscar_stock', { texto: 'polo', sucursal: '' });
    expect(r.content).toContain('Polo propio');
    expect(r.content).not.toContain('secreto');
    expect(r.content).not.toContain('cost');
    expect((await runTool(ctx, 'borrar_todo', {})).isError).toBe(true);
    await expect(withTenant(a.tenantId, (tx) => tx.variant.updateMany({ data: { price: 1 } }), { readOnly: true })).rejects.toThrow();
  });

  it('registra el consumo por consulta usando la herramienta', async () => {
    const { client, calls } = fakeClient({ useTool: true });
    const r = await askAgent(await ctxOf(a), '¿Qué polos hay?', client);
    expect(r.answer).toBe('Hay stock.');
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].messages)).toContain('Polo propio');
    const rows = await withTenant(a.tenantId, (tx) => tx.aiUsage.findMany({ where: { status: 'OK' } }));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.model === 'claude-haiku-5-5')).toBe(true);
    expect(calls.every((c) => c.model === 'claude-haiku-5-5')).toBe(true);
    expect(Number(rows[0].costUsd)).toBeCloseTo(costUsd(haiku, 1000, 500), 8);
  });

  it('nunca supera el límite, ni con consultas simultáneas, y avisa al negocio', async () => {
    await resetAiUsage(a.root, a.tenantId);
    await limit('USD', 0.01);
    const ctx = await ctxOf(a);
    const { client, calls } = fakeClient({ outputTokens: 4000 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => askAgent(ctx, 'stock', client)));
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
    expect(calls.length).toBeLessThan(8);
    const since = (await withTenant(a.tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: a.tenantId } }))).aiUsageResetAt;
    for (let i = 0; i < 5; i++) await askAgent(ctx, 'stock', client).catch(() => undefined);
    expect((await spentSince(a.tenantId, since)).usd).toBeLessThanOrEqual(0.01);
    await expect(askAgent(ctx, 'stock', client)).rejects.toThrow('límite');
    expect(await withTenant(a.tenantId, (tx) => tx.supervisorNotice.count({ where: { type: 'AI_LIMIT' } }))).toBe(1);
  });

  it('respeta el límite en tokens y se reactiva al reiniciar el consumo', async () => {
    await resetAiUsage(a.root, a.tenantId);
    await limit('TOKENS', 100);
    const ctx = await ctxOf(a);
    await expect(askAgent(ctx, 'stock', fakeClient().client)).rejects.toThrow('límite');
    await limit('TOKENS', 100_000);
    await expect(askAgent(await ctxOf(a), 'stock', fakeClient().client)).resolves.toMatchObject({ answer: 'Hay stock.' });
  });

  describe('fallos: un solo intento, sin cambiar de modelo', () => {
    const since = async () => (await withTenant(a.tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: a.tenantId } }))).aiUsageResetAt;
    const failing = (error: Error) => {
      const create = vi.fn(async () => { throw error; });
      return { create, client: { countTokens: async () => ({ input_tokens: 1000 }), create } as ModelClient };
    };
    beforeAll(async () => {
      await limit('USD', 1);
    });

    it('error del servicio: mensaje para reintentar y sin costo', async () => {
      await resetAiUsage(a.root, a.tenantId);
      const { client, create } = failing(Anthropic.APIError.generate(529, undefined, 'saturado', new Headers()));
      await expect(askAgent(await ctxOf(a), 'stock', client)).rejects.toThrow(RETRY_MESSAGE);
      expect(create).toHaveBeenCalledTimes(1);
      expect((await spentSince(a.tenantId, await since())).usd).toBe(0);
    });

    it('corte de red: no reintenta y conserva la reserva, por si se facturó', async () => {
      await resetAiUsage(a.root, a.tenantId);
      const { client, create } = failing(new Anthropic.APIConnectionError({ message: 'corte' }));
      await expect(askAgent(await ctxOf(a), 'stock', client)).rejects.toThrow(RETRY_MESSAGE);
      expect(create).toHaveBeenCalledTimes(1);
      expect((await spentSince(a.tenantId, await since())).usd).toBeGreaterThan(0);
    });

    it('negativa del modelo: mensaje claro y una sola llamada', async () => {
      const { client, calls } = fakeClient();
      const original = client.create;
      client.create = async (params) => ({ ...(await original(params)), stop_reason: 'refusal', content: [] });
      await expect(askAgent(await ctxOf(a), 'stock', client)).resolves.toMatchObject({ answer: REFUSAL_MESSAGE });
      expect(calls).toHaveLength(1);
    });

    it('no envía entradas que saltarían al tramo de precio superior', async () => {
      const { client, calls } = fakeClient();
      client.countTokens = async () => ({ input_tokens: 99_000 });
      await expect(askAgent(await ctxOf(a), 'stock', client)).rejects.toThrow('demasiados datos');
      expect(calls).toHaveLength(0);
    });
  });
});
