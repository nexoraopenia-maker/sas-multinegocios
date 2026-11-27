'use client';
import { useState } from 'react';
import { useStore } from '@/client/store';
import { Empty, Field, Notice, Page, useAction, when } from '@/client/ui/kit';
import { ProductPicker, stockOf, useItems } from '@/client/ui/products';
import type { TransferDto } from '@/shared/snapshot';

const STATE: Record<TransferDto['status'], [string, string]> = {
  REQUESTED: ['warn', 'Solicitado'], APPROVED: ['info', 'Aprobado'], SHIPPED: ['info', 'En camino'], RECEIVED: ['ok', 'Recibido'], REJECTED: ['danger', 'Rechazado'], CANCELLED: ['danger', 'Cancelado'],
};
const n = (v: string) => Number(v.replace(',', '.')) || 0;

export default function Transfers() {
  const { view, branchId, submit, can, user } = useStore();
  const { byId } = useItems();
  const s = view!;
  const others = s.branches.filter((b) => b.id !== branchId);
  const [from, setFrom] = useState('');
  const [lines, setLines] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const { busy, message, run } = useAction();
  const source = from || others[0]?.id || '';
  const name = (id: string) => s.branches.find((b) => b.id === id)?.name ?? '';

  if (!user.features.multiBranch) return <Page title="Traslados"><Empty>La función multisucursal no está habilitada.</Empty></Page>;

  return (
    <Page title="Traslados entre sucursales">
      <Notice message={message} />
      {can('transfer.request') && others.length > 0 && (
        <section className="card stack">
          <h2>Pedir mercadería para {name(branchId)}</h2>
          <Field label="Desde la sucursal"><select value={source} onChange={(e) => setFrom(e.target.value)}>{others.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <ProductPicker onPick={(i) => setLines({ ...lines, [i.variant.id]: lines[i.variant.id] ?? '1' })} />
          {Object.entries(lines).map(([id, q]) => (
            <div key={id} className="row between"><span className="grow">{byId.get(id)?.label}<small>Disponible en {name(source)}: {stockOf(s, source, id)}</small></span>
              <input className="qty" inputMode="decimal" aria-label="Cantidad" value={q} onChange={(e) => setLines({ ...lines, [id]: e.target.value })} />
              <button className="btn ghost" aria-label="Quitar" onClick={() => { const next = { ...lines }; delete next[id]; setLines(next); }}>✕</button></div>
          ))}
          {Object.keys(lines).length > 0 && <><Field label="Nota"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <button className="btn primary" disabled={busy} onClick={() => run(async () => {
              const items = Object.entries(lines).map(([variantId, q]) => ({ variantId, quantity: n(q) }));
              if (items.some((i) => i.quantity <= 0)) throw new Error('Revisa las cantidades.');
              const r = await submit('transfer.request', { transferId: crypto.randomUUID(), fromBranchId: source, toBranchId: branchId, notes, items });
              setLines({}); setNotes(''); return r.state === 'queued' ? 'Solicitud guardada; se enviará con conexión.' : 'Solicitud enviada';
            })}>Solicitar traslado</button></>}
        </section>
      )}
      {others.length === 0 && <p className="msg info">Se necesitan al menos dos sucursales.</p>}
      <h2>Traslados</h2>
      {s.transfers.map((t) => <TransferCard key={`${t.id}-${t.status}`} t={t} />)}
      {!s.transfers.length && <Empty>Aún no hay traslados.</Empty>}
    </Page>
  );
}

function TransferCard({ t }: { t: TransferDto }) {
  const { view, submit, submitOnline, can, user, online } = useStore();
  const { byId } = useItems();
  const s = view!;
  const { busy, message, run } = useAction();
  const outbound = user.branchIds.includes(t.fromBranchId);
  const inbound = user.branchIds.includes(t.toBranchId);
  const canShip = t.status === 'APPROVED' && outbound && can('transfer.operate');
  const canReceive = t.status === 'SHIPPED' && inbound && can('transfer.operate');
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(t.items.map((i) => [i.variantId, String(t.status === 'SHIPPED' ? i.shipped : i.requested)])));
  const name = (id: string) => s.branches.find((b) => b.id === id)?.name ?? '';
  const move = (type: 'transfer.ship' | 'transfer.receive') => run(async () => {
    const r = await submit(type, { transferId: t.id, items: t.items.map((i) => ({ variantId: i.variantId, quantity: n(qty[i.variantId]) })) });
    return r.state === 'queued' ? 'Guardado; se sincronizará con conexión.' : 'Registrado';
  });
  const online_ = (fn: () => Promise<unknown>) => run(async () => { await fn(); });
  return (
    <details className="card" open={['REQUESTED', 'APPROVED', 'SHIPPED'].includes(t.status)}>
      <summary><b>{name(t.fromBranchId)} → {name(t.toBranchId)}</b> · {when(t.requestedAt)} <span className={`tag ${STATE[t.status][0]}`}>{STATE[t.status][1]}</span></summary>
      {t.notes && <p>{t.notes}</p>}
      {t.items.map((i) => (
        <div key={i.variantId} className="row between"><span className="grow">{byId.get(i.variantId)?.label}<small>Pedido {i.requested} · Enviado {i.shipped} · Recibido {i.received}</small></span>
          {(canShip || canReceive) && <input className="qty" inputMode="decimal" aria-label={canShip ? 'A enviar' : 'Recibido'} value={qty[i.variantId]} onChange={(e) => setQty({ ...qty, [i.variantId]: e.target.value })} />}</div>
      ))}
      <div className="row">
        {t.status === 'REQUESTED' && outbound && can('transfer.approve') && <>
          <button className="btn primary" disabled={busy || !online} onClick={() => online_(() => submitOnline('transfer.review', { transferId: t.id, approve: true }))}>Aprobar</button>
          <button className="btn danger" disabled={busy || !online} onClick={() => online_(() => submitOnline('transfer.review', { transferId: t.id, approve: false }))}>Rechazar</button></>}
        {canShip && <button className="btn primary" disabled={busy} onClick={() => move('transfer.ship')}>Registrar envío</button>}
        {canReceive && <button className="btn primary" disabled={busy} onClick={() => move('transfer.receive')}>Confirmar recepción</button>}
        {['REQUESTED', 'APPROVED'].includes(t.status) && can('transfer.request') && <button className="btn ghost" disabled={busy} onClick={() => online_(() => submit('transfer.cancel', { transferId: t.id }))}>Cancelar traslado</button>}
      </div>
      <Notice message={message} />
    </details>
  );
}
