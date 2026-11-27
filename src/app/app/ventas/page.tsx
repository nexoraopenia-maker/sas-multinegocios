'use client';
import { useState } from 'react';
import { api } from '@/client/api';
import { useStore } from '@/client/store';
import { Empty, Field, Modal, Notice, Page, useAction, useLoad, when } from '@/client/ui/kit';
import { Receipt } from '@/client/ui/Receipt';
import { receiptNumber } from '@/shared/codes';
import { money } from '@/shared/money';
import { PAYMENT_LABELS, type Payload, type PaymentMethodT } from '@/shared/operations';
import { todayISO } from '@/shared/stock';

type Row = { id: string; series: string; number: number; total: number; status: string; user: string; occurredAt: string; methods: PaymentMethodT[] };
type Detail = Row & {
  branchId: string; subtotal: number; discount: number; voidReason: string | null;
  customer: { name: string; docNumber: string; phone: string; email: string } | null;
  items: { id: string; description: string; quantity: number; unitPrice: number; discount: number; total: number; returnedQty: number }[];
  payments: { method: PaymentMethodT; amount: number }[];
  returns: { id: string; total: number; reason: string; refundMethod: PaymentMethodT; occurredAt: string; voucherCode: string | null }[];
};

export default function Sales() {
  const { branchId, can } = useStore();
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, reload } = useLoad(() => api<Row[]>(`sales?branchId=${branchId}&from=${from}&to=${to}`), [branchId, from, to]);
  const { view, outbox } = useStore();
  const local = outbox.filter((i) => i.op.type === 'sale.create' && i.branchId === branchId && i.status !== 'SENT');

  return (
    <Page title="Ventas">
      <div className="row"><Field label="Desde"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="Hasta"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
      {local.length > 0 && (
        <div className="card"><b>En este dispositivo, sin sincronizar</b>
          <ul>{local.map((i) => { const p = i.op.payload as Payload<'sale.create'>; return <li key={i.id}>{receiptNumber(p.series, p.number)} · {when(i.op.clientTime)} · {money(p.payments.reduce((a, x) => a + x.amount, 0))} {i.status === 'REJECTED' && <span className="tag danger">Rechazada: {i.error}</span>}</li>; })}</ul>
        </div>
      )}
      {error && <p className="msg info">{error}</p>}
      {data && (
        <div className="table-wrap"><table>
          <thead><tr><th>Comprobante</th><th>Fecha</th><th>Vendedor</th><th>Pago</th><th>Estado</th><th className="num">Total</th></tr></thead>
          <tbody>{data.map((r) => (
            <tr key={r.id}><td><button className="link" onClick={() => setOpen(r.id)}>{receiptNumber(r.series, r.number)}</button></td><td>{when(r.occurredAt)}</td><td>{r.user}</td>
              <td>{r.methods.map((m) => PAYMENT_LABELS[m]).join(', ')}</td><td><span className={`tag ${r.status === 'VOIDED' ? 'danger' : 'ok'}`}>{r.status === 'VOIDED' ? 'Anulada' : 'Completada'}</span></td><td className="num">{money(r.total)}</td></tr>
          ))}</tbody>
        </table>{!data.length && <Empty>No hay ventas en estas fechas.</Empty>}</div>
      )}
      {open && view && <SaleModal id={open} onClose={() => { setOpen(null); reload(); }} canVoid={can('sale.void')} canReturn={can('sale.return')} branchName={view.branches.find((b) => b.id === branchId)?.name ?? ''} />}
    </Page>
  );
}

function SaleModal({ id, onClose, canVoid, canReturn, branchName }: { id: string; onClose: () => void; canVoid: boolean; canReturn: boolean; branchName: string }) {
  const { view, submitOnline } = useStore();
  const { data: sale, error, reload } = useLoad(() => api<Detail>(`sales/${id}`), [id]);
  const [mode, setMode] = useState<'view' | 'void' | 'return'>('view');
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<PaymentMethodT>('VOUCHER');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [damaged, setDamaged] = useState<Record<string, boolean>>({});
  const { busy, message, run } = useAction();
  const cashSessionId = view?.cashSession?.id ?? null;

  const doVoid = () => run(async () => {
    await submitOnline('sale.void', { saleId: id, reason, cashSessionId });
    setMode('view'); reload(); return 'Venta anulada. El stock fue repuesto.';
  });
  const doReturn = () => run(async () => {
    const items = Object.entries(qty).filter(([, q]) => Number(q) > 0).map(([saleItemId, q]) => ({ saleItemId, quantity: Number(q), restock: !damaged[saleItemId] }));
    if (!items.length) throw new Error('Indica qué cantidades se devuelven.');
    const r = await submitOnline('sale.return', { returnId: crypto.randomUUID(), saleId: id, reason, refundMethod: method, cashSessionId, items });
    setMode('view'); setQty({}); reload();
    const result = r.result as { total: number; voucherCode: string | null };
    return `Devolución por ${money(result.total)}.${result.voucherCode ? ` Vale: ${result.voucherCode}` : ''}`;
  });

  return (
    <Modal title="Detalle de venta" onClose={onClose}>
      {error && <p className="msg error">{error}</p>}
      <Notice message={message} />
      {sale && mode === 'view' && view && (
        <>
          <Receipt settings={view.settings} data={{ ...sale, branch: view.branches.find((b) => b.id === sale.branchId)?.name ?? branchName }} />
          {sale.voidReason && <p className="msg error no-print">Anulada: {sale.voidReason}</p>}
          {sale.returns.map((r) => <p key={r.id} className="msg info no-print">Devolución {money(r.total)} ({PAYMENT_LABELS[r.refundMethod]}) · {r.reason}{r.voucherCode && ` · Vale ${r.voucherCode}`}</p>)}
          {sale.status === 'COMPLETED' && (
            <div className="row no-print">
              {canReturn && <button className="btn" onClick={() => setMode('return')}>Devolución o cambio</button>}
              {canVoid && !sale.returns.length && <button className="btn danger" onClick={() => setMode('void')}>Anular venta</button>}
            </div>
          )}
        </>
      )}
      {sale && mode !== 'view' && (
        <div className="stack">
          {mode === 'return' && (
            <>
              {sale.items.map((i) => (
                <div key={i.id} className="row between">
                  <span>{i.description}<small>Quedan {i.quantity - i.returnedQty}</small></span>
                  <span className="row nowrap"><input className="qty" inputMode="decimal" placeholder="0" aria-label={`Cantidad a devolver de ${i.description}`} value={qty[i.id] ?? ''} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} />
                    <label className="check"><input type="checkbox" checked={!!damaged[i.id]} onChange={(e) => setDamaged({ ...damaged, [i.id]: e.target.checked })} /> Dañado</label></span>
                </div>
              ))}
              <Field label="Reembolso" hint="Para un cambio, emite un vale y úsalo como pago en la nueva venta.">
                <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethodT)}>{Object.entries(PAYMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </Field>
            </>
          )}
          <Field label="Motivo"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="row"><button className="btn" onClick={() => setMode('view')}>Volver</button>
            <button className="btn primary" disabled={busy || reason.trim().length < 3} onClick={mode === 'void' ? doVoid : doReturn}>{mode === 'void' ? 'Confirmar anulación' : 'Registrar devolución'}</button></div>
        </div>
      )}
    </Modal>
  );
}
