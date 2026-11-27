'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/client/api';
import { useStore } from '@/client/store';
import { Empty, Field, Notice, Page, useAction, useLoad, useQueryParam, when } from '@/client/ui/kit';
import { money } from '@/shared/money';
import { PAYMENT_LABELS } from '@/shared/operations';

type Session = {
  id: string; user: string; openedAt: string; closedAt: string | null; openingAmount: number;
  expected: Record<string, number> | null; counted: Record<string, number> | null; difference: number | null; notes: string; reviewedBy: string | null;
};
const QUICK_AMOUNTS = [0, 50, 100, 200, 500];
const METHODS = ['CASH', 'YAPE', 'PLIN', 'CARD', 'TRANSFER'] as const;
const n = (v: string | undefined) => Number((v ?? '').replace(',', '.')) || 0;

export default function Cash() {
  const { view, branchId, submit, can, lastSync, outbox } = useStore();
  const s = view!;
  const [opening, setOpening] = useState('');
  const openParam = useQueryParam('abrir');
  const openingRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (openParam) openingRef.current?.focus(); }, [openParam]);
  const [move, setMove] = useState({ type: 'OUT' as 'IN' | 'OUT', amount: '', reason: '' });
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const { busy, message, run } = useAction();
  const history = useLoad(() => api<Session[]>(`cash?branchId=${branchId}`), [branchId, lastSync, outbox.length]);
  const queued = (state: string, text: string) => (state === 'queued' ? `${text} (se sincronizará al volver la conexión)` : text);

  return (
    <Page title="Caja">
      <Notice message={message} />
      {!s.cashSession ? (
        <form className="card stack narrow" onSubmit={(e) => { e.preventDefault(); void run(async () => {
          const r = await submit('cash.open', { cashSessionId: crypto.randomUUID(), branchId, openingAmount: n(opening) });
          setOpening(''); return queued(r.state, 'Caja abierta');
        }); }}>
          <h2>Abrir caja</h2>
          <Field label="Monto inicial en efectivo"><input ref={openingRef} inputMode="decimal" required value={opening} onChange={(e) => setOpening(e.target.value)} /></Field>
          <div className="row" role="group" aria-label="Montos rápidos">
            {QUICK_AMOUNTS.map((a) => <button key={a} type="button" className="btn" aria-pressed={opening !== '' && n(opening) === a} onClick={() => setOpening(String(a))}>S/ {a}</button>)}
          </div>
          <button className="btn primary big" disabled={busy}>Abrir caja</button>
        </form>
      ) : (
        <div className="cards wide">
          <section className="card stack">
            <h2>Caja abierta</h2>
            <p>Desde {when(s.cashSession.openedAt)} · Apertura {money(s.cashSession.openingAmount)}</p>
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => {
              const r = await submit('cash.movement', { cashSessionId: s.cashSession!.id, type: move.type, amount: n(move.amount), reason: move.reason });
              setMove({ ...move, amount: '', reason: '' }); return queued(r.state, 'Movimiento registrado');
            }); }}>
              <h3>Ingreso o retiro de efectivo</h3>
              <div className="grid2">
                <Field label="Tipo"><select value={move.type} onChange={(e) => setMove({ ...move, type: e.target.value as 'IN' | 'OUT' })}><option value="OUT">Retiro / gasto</option><option value="IN">Ingreso</option></select></Field>
                <Field label="Monto"><input inputMode="decimal" required value={move.amount} onChange={(e) => setMove({ ...move, amount: e.target.value })} /></Field>
              </div>
              <Field label="Motivo"><input required minLength={3} value={move.reason} onChange={(e) => setMove({ ...move, reason: e.target.value })} /></Field>
              <button className="btn" disabled={busy}>Registrar</button>
            </form>
          </section>
          <form className="card stack" onSubmit={(e) => { e.preventDefault(); if (!confirm('¿Cerrar la caja con estos montos?')) return; void run(async () => {
            const r = await submit('cash.close', { cashSessionId: s.cashSession!.id, notes, counted: Object.fromEntries(METHODS.map((m) => [m, n(counted[m])])) as Record<(typeof METHODS)[number], number> });
            setCounted({}); setNotes('');
            if (r.state === 'queued') return 'Cierre guardado. El cuadre se calculará al sincronizar.';
            return `Caja cerrada. Diferencia: ${money((r.result as { difference: number }).difference)}`;
          }); }}>
            <h2>Arqueo y cierre</h2>
            <p className="muted">Cuenta lo que tienes y anota el total por medio de pago.</p>
            <div className="grid2">{METHODS.map((m) => <Field key={m} label={PAYMENT_LABELS[m]}><input inputMode="decimal" placeholder="0.00" required={m === 'CASH'} value={counted[m] ?? ''} onChange={(e) => setCounted({ ...counted, [m]: e.target.value })} /></Field>)}</div>
            <Field label="Observaciones"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <button className="btn primary" disabled={busy}>Cerrar caja</button>
          </form>
        </div>
      )}
      <h2>Cierres recientes</h2>
      {history.error && <p className="msg info">{history.error}</p>}
      {history.data && (
        <div className="table-wrap"><table>
          <thead><tr><th>Apertura</th><th>Cierre</th><th>Usuario</th><th>Detalle (esperado / contado)</th><th className="num">Diferencia</th><th>Revisión</th></tr></thead>
          <tbody>{history.data.map((c) => (
            <tr key={c.id}><td>{when(c.openedAt)}</td><td>{c.closedAt ? when(c.closedAt) : <span className="tag ok">Abierta</span>}</td><td>{c.user}</td>
              <td>{c.expected ? METHODS.filter((m) => c.expected![m] || c.counted?.[m]).map((m) => <small key={m}>{PAYMENT_LABELS[m]}: {money(c.expected![m])} / {c.counted ? money(c.counted[m] ?? 0) : '—'}</small>) : '—'}{c.notes && <small>{c.notes}</small>}</td>
              <td className={`num ${c.difference ? 'warn-text' : ''}`}>{c.difference === null ? '—' : money(c.difference)}</td>
              <td>{c.reviewedBy ?? (c.closedAt && can('cash.review') ? <button className="btn" onClick={() => void run(async () => { await api(`cash/${c.id}/review`, { body: {} }); history.reload(); })}>Marcar revisado</button> : '—')}</td></tr>
          ))}</tbody>
        </table>{!history.data.length && <Empty>Sin cajas recientes.</Empty>}</div>
      )}
    </Page>
  );
}
