/** Modelo del asistente de stock (Claude) cuando AI_MODEL no indica un modelo de Claude. */
export const DEFAULT_AI_MODEL = 'claude-haiku-5-5';

type Env = Record<string, string | undefined>;
const isClaude = (model: string) => model.startsWith('claude');

/** El asistente de stock usa la API de Claude: ignora un AI_MODEL de otro proveedor. */
export function stockAgentModel(env: Env): string {
  const model = env.AI_MODEL?.trim();
  return model && isClaude(model) ? model : DEFAULT_AI_MODEL;
}

/** El escaneo de comprobantes usa OpenAI: OPENAI_MODEL o, si no, AI_MODEL cuando no es de Claude. */
export function scanModel(env: Env): string | null {
  const own = env.OPENAI_MODEL?.trim();
  if (own) return own;
  const shared = env.AI_MODEL?.trim();
  return shared && !isClaude(shared) ? shared : null;
}
