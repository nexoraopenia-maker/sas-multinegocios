'use client';
import { useState } from 'react';
import { useStore } from '@/client/store';
import { Empty, Field, Notice, Page, useAction, when } from '@/client/ui/kit';
import { ProductPicker, stockOf, useItems, type Item } from '@/client/ui/products';
import { round3 } from '@/shared/money';
import type { Snapshot } from '@/shared/snapshot';

type Kind = 'ADJUSTMENT' | 'WASTE' | 'COUNT';
interface Line { variantId: string; lotId: string; value: string }
const KINDS: Record<Kind, string> = { ADJUSTMENT: 'Ajuste', WASTE: 'Merma', COUNT: 'Conteo físico' };
const n = (v: string) => Number(v.replace(',', '.'));

export default function Adjustments() {
  const { view, branchId, submit, submitOnline, can, online } = useStore();
  const { byId } = useItems();
  const s = view!;
  const [kind, setKind] = useState<Kind>('COUNT');
  const [lines, setLines] = useState<Line[]>([]);
  const [reason, setReason] = useState('');
  const { busy, message, run } = useAction();
  const lotsOf = (variantId: string) => s.balances.filter((b) => b.branchId === branchId && b.variantId === variantId && b.lotId).map((b) => ({ ...s.lots.find((l) => l.id === b.lotId)!, quantity: b.quantity })).filter((l) => l.id && !l.id.startsWith('local:'));
  const current = (l: { variantId: string; lotId: string }) => l.lotId ? s.balances.find((b) => b.branchId === branchId && b.variantId === l.variantId && b.lotId === l.lotId)?.quantity ?? 0 : stockOf(s, branchId, l.variantId);

  const add = (item: Item) => setLines((old) => {
    const lots = lotsOf(item.variant.id);
    // En conteos de productos con lotes se cuenta lote por lote.
    if (lots.length) {
      const next = lots.find((x) => !old.some((l) => l.variantId === item.variant.id && l.lotId === x.id));
      return next ? [...old, { variantId: item.variant.id, lotId: next.id, value: '' }] : old;
    }
    const i = old.findIndex((l) => l.variantId === item.variant.id);
    if (i >= 0) return kind === 'COUNT' ? old.map((l, j) => (j === i ? { ...l, value: String(n(l.value || '0') + 1) } : l)) : old;
    return [...old, { variantId: item.variant.id, lotId: '', value: '' }];
  });

  const send = () => run(async () => {
    const items = lines.map((l) => {
      const v = n(l.value);
      if (l.value.trim() === '' || !Number.isFinite(v)) throw new Error(`Falta la cantidad de ${byId.get(l.variantId)?.label}`);
      if (kind === 'COUNT') return { variantId: l.variantId, lotId: l.lotId || null, countedQty: v, expectedQty: current(l), delta: round3(v - current(l)) };
      if (v === 0) throw new Error('La cantidad no puede ser cero');
      return { variantId: l.variantId, lotId: l.lotId || null, delta: kind === 'WASTE' ? -Math.abs(v) : v };
    });
    const r = await submit('adjustment.request', { adjustmentId: crypto.randomUUID(), branchId, kind, reason, items });
    setLines([]); setReason('');
    return r.state === 'queued' ? 'Solicitud guardada. Se enviará al volver la conexión.' : 'Solicitud enviada. El stock cambiará cuando un supervisor la apruebe.';
  });

  const list = s.adjustments.filter((a) => a.branchId === branchId);
  return (
    <Page title="Ajustes, mermas y conteo">
      <Notice message={message} />
      {can('stock.adjust.request') && (
        <section className="card stack">
          <div className="tabs">{(Object.keys(KINDS) as Kind[]).map((k) => <button key={k} className="btn" aria-pressed={kind === k} onClick={() => { setKind(k); setLines([]); }}>{KINDS[k]}</button>)}</div>
          <p className="muted">{kind === 'COUNT' ? 'Anota lo que cuentas físicamente. El sistema calcula la diferencia.' : kind === 'WASTE' ? 'Productos dañados, vencidos o perdidos.' : 'Usa un número negativo para descontar.'}</p>
          <ProductPicker onPick={add} onlyActive={false} />
          {lines.map((l, i) => (
            <div key={`${l.variantId}-${l.lotId}`} className="row between">
              <span className="grow">{byId.get(l.variantId)?.label}<small>{lotsOf(l.variantId).find((x) => x.id === l.lotId) ? `Lote ${lotsOf(l.variantId).find((x) => x.id === l.lotId)!.code} · ` : ''}En sistema: {current(l)}</small></span>
              <input className="qty" inputMode="decimal" aria-label={kind === 'COUNT' ? 'Cantidad contada' : 'Cantidad'} placeholder={kind === 'COUNT' ? 'Contado' : 'Cantidad'} value={l.value} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <button className="btn ghost" aria-label="Quitar" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          {lines.length > 0 && <><Field label="Motivo"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field><button className="btn primary" disabled={busy || reason.trim().length < 3} onClick={send}>Enviar para aprobación</button></>}
        </section>
      )}
      <h2>Solicitudes</h2>
      {list.map((a) => <AdjustmentCard key={a.id} a={a} label={(id) => byId.get(id)?.label ?? ''} actions={a.status === 'PENDING' && can('stock.adjust.approve') && (
        <div className="row"><button className="btn primary" disabled={busy || !online} onClick={() => run(async () => { await submitOnline('adjustment.review', { adjustmentId: a.id, approve: true }); return 'Aprobado. El kárdex fue actualizado.'; })}>Aprobar</button>
          <button className="btn danger" disabled={busy || !online} onClick={() => run(async () => { await submitOnline('adjustment.review', { adjustmentId: a.id, approve: false }); return 'Rechazado'; })}>Rechazar</button></div>
      )} />)}
      {!list.length && <Empty>No hay solicitudes en esta sucursal.</Empty>}
    </Page>
  );
}

function AdjustmentCard({ a, label, actions }: { a: Snapshot['adjustments'][number]; label: (id: string) => string; actions: React.ReactNode }) {
  const state = { PENDING: ['warn', 'Pendiente'], APPROVED: ['ok', 'Aprobado'], REJECTED: ['danger', 'Rechazado'] }[a.status];
  return (
    <details className="card" open={a.status === 'PENDING'}>
      <summary><b>{KINDS[a.kind]}</b> · {when(a.requestedAt)} · {a.requestedByName} <span className={`tag ${state[0]}`}>{state[1]}</span></summary>
      <p>{a.reason}</p>
      <ul>{a.items.map((i, k) => <li key={k}>{label(i.variantId)}: {a.kind === 'COUNT' ? `contado ${i.countedQty}, sistema ${i.expectedQty ?? '—'}, diferencia ${i.delta}` : i.delta}</li>)}</ul>
      {a.kind === 'COUNT' && a.status === 'PENDING' && <p className="muted">Al aprobar, la diferencia se recalcula contra el stock que había a la hora del conteo.</p>}
      {actions}
    </details>
  );
}
