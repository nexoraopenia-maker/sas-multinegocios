import { modelPrices } from '@/server/platform';
import { scanModel, stockAgentModel } from '@/shared/ai';
import { ActionForm } from '../ActionForm';
import { priceAction } from '../actions';
import { requireSuper } from '../session';

export default async function Models() {
  const prices = await modelPrices(await requireSuper());
  const current = stockAgentModel(process.env);
  const scanner = scanModel(process.env);
  const form = (model: string, input?: number, output?: number) => (
    <ActionForm key={model} action={priceAction} className="card grid3" submit={model ? 'Actualizar' : 'Agregar modelo'} tone={model ? '' : 'primary'}>
      <label className="field"><span>Modelo {(model === current || model === scanner) && <span className="tag ok">en uso</span>}</span><input name="model" required defaultValue={model} readOnly={!!model} /></label>
      <label className="field"><span>US$ por millón de tokens de entrada</span><input name="inputPerMTok" type="number" step="0.0001" min="0.0001" required defaultValue={input} /></label>
      <label className="field"><span>US$ por millón de tokens de salida</span><input name="outputPerMTok" type="number" step="0.0001" min="0.0001" required defaultValue={output} /></label>
    </ActionForm>
  );
  return (
    <>
      <h1>Modelos de IA y costos</h1>
      <p className="muted">El asistente de stock usa <b>{current}</b> (Claude). El escaneo de comprobantes usa {scanner ? <b>{scanner}</b> : <b>ningún modelo: define OPENAI_MODEL o un modelo de OpenAI en AI_MODEL</b>} (OpenAI). Verifica los precios con tu proveedor: de ellos depende el control del límite.</p>
      {scanner && !prices.some((p) => p.model === scanner) && <p className="msg error">Agrega el precio de {scanner} más abajo; sin él no se puede escanear.</p>}
      {prices.map((p) => form(p.model, Number(p.inputPerMTok), Number(p.outputPerMTok)))}
      <h2>Otro modelo</h2>
      {form('')}
    </>
  );
}
