'use client';
import { useState } from 'react';
import { api } from '@/client/api';
import { useStore } from '@/client/store';
import { errorText } from '@/client/api';
import { Page } from '@/client/ui/kit';

type Entry = { from: 'user' | 'agent' | 'error'; text: string };
const EXAMPLES = ['¿Qué productos tienen bajo stock?', '¿Qué vence en los próximos 15 días?', '¿Cuánto stock hay de polos talla M en cada sucursal?'];

export default function Agent() {
  const { user, online } = useStore();
  const [log, setLog] = useState<Entry[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  if (!user.features.aiAgent) return <Page title="Asistente de stock"><p className="msg info">El asistente de IA no está activado para tu negocio. Solicítalo a tu proveedor.</p></Page>;
  const ask = async (text: string) => {
    if (busy || !text.trim()) return;
    setBusy(true); setQuestion(''); setLog((l) => [...l, { from: 'user', text }]);
    try {
      const r = await api<{ answer: string }>('agent', { body: { question: text }, timeout: 60_000 });
      setLog((l) => [...l, { from: 'agent', text: r.answer }]);
    } catch (e) { setLog((l) => [...l, { from: 'error', text: errorText(e) }]); }
    finally { setBusy(false); }
  };
  return (
    <Page title="Asistente de stock">
      <p className="muted">Solo consulta tu inventario; no modifica datos. Cada pregunta se responde por separado.</p>
      {!online && <p className="msg info">El asistente necesita conexión. El resto del sistema sigue funcionando.</p>}
      <div className="chat" aria-live="polite">
        {!log.length && <div className="row">{EXAMPLES.map((e) => <button key={e} className="btn" disabled={!online} onClick={() => void ask(e)}>{e}</button>)}</div>}
        {log.map((m, i) => <p key={i} className={`bubble ${m.from}`}>{m.text}</p>)}
        {busy && <p className="bubble agent muted">Consultando…</p>}
      </div>
      <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
        <input className="grow" maxLength={600} placeholder="Pregunta sobre tu stock…" aria-label="Pregunta" value={question} disabled={!online} onChange={(e) => setQuestion(e.target.value)} />
        <button className="btn primary" disabled={busy || !online || question.trim().length < 2}>Enviar</button>
      </form>
    </Page>
  );
}
