import { modelPrices } from '@/server/platform';
import { DEFAULT_AI_MODEL } from '@/shared/ai';
import { ActionForm } from '../ActionForm';
import { priceAction } from '../actions';
import { requireSuper } from '../session';

export default async function Models() {
  const prices = await modelPrices(await requireSuper());
  const current = process.env.AI_MODEL || DEFAULT_AI_MODEL;
  const form = (model: string, input?: number, output?: number) => (
    <ActionForm key={model} action={priceAction} className="card grid3" submit={model ? 'Actualizar' : 'Agregar modelo'} tone={model ? '' : 'primary'}>
      <label className="field"><span>Modelo {model === current && <span className="tag ok">en uso</span>}</span><input name="model" required defaultValue={model} readOnly={!!model} /></label>
      <label className="field"><span>US$ por millón de tokens de entrada</span><input name="inputPerMTok" type="number" step="0.0001" min="0.0001" required defaultValue={input} /></label>
      <label className="field"><span>US$ por millón de tokens de salida</span><input name="outputPerMTok" type="number" step="0.0001" min="0.0001" required defaultValue={output} /></label>
    </ActionForm>
  );
  return (
    <>
      <h1>Modelos de IA y costos</h1>
      <p className="muted">El agente usa <b>{current}</b> (variable AI_MODEL). Verifica los precios con tu proveedor: de ellos depende el control del límite.</p>
      {prices.map((p) => form(p.model, Number(p.inputPerMTok), Number(p.outputPerMTok)))}
      <h2>Otro modelo</h2>
      {form('')}
    </>
  );
}
