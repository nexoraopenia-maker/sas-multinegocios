'use client';
import { useMemo, useState } from 'react';
import { api } from '@/client/api';
import { useStore } from '@/client/store';
import { Field, Modal, Notice, Page, useAction } from '@/client/ui/kit';
import { ProductPicker, stockOf, useItems, type Item } from '@/client/ui/products';
import { Receipt, type ReceiptData } from '@/client/ui/Receipt';
import { money, round2, saleTotals } from '@/shared/money';
import { PAYMENT_LABELS, type PaymentMethodT } from '@/shared/operations';
import { allocateFefo } from '@/shared/stock';

interface Line { variantId: string; quantity: string; price: string; discount: string; lotId: string }
interface Pay { method: PaymentMethodT; amount: string; reference: string }
const n = (v: string) => Number(v.replace(',', '.')) || 0;

export default function Pos() {
  const { view, branchId, device, user, can, submit, nextNumber, online } = useStore();
  const { byId } = useItems();
  const s = view!;
  const [cart, setCart] = useState<Line[]>([]);
  const [paying, setPaying] = useState(false);
  const [payments, setPayments] = useState<Pay[]>([]);
  const [customer, setCustomer] = useState({ id: '', name: '', docNumber: '', phone: '', email: '' });
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const { busy, message, setMessage, run } = useAction();

  const totals = saleTotals(cart.map((l) => ({ quantity: n(l.quantity), unitPrice: n(l.price), discount: n(l.discount) })));
  const paid = round2(payments.reduce((sum, p) => sum + n(p.amount), 0));
  const cashPaid = round2(payments.filter((p) => p.method === 'CASH').reduce((sum, p) => sum + n(p.amount), 0));
  const change = round2(Math.max(0, paid - totals.total));
  const missing = round2(totals.total - paid);

  const add = (item: Item) => {
    setMessage(null);
    setCart((old) => {
      const i = old.findIndex((l) => l.variantId === item.variant.id && !l.lotId);
      if (i >= 0) return old.map((l, j) => (j === i ? { ...l, quantity: String(n(l.quantity) + 1) } : l));
      return [...old, { variantId: item.variant.id, quantity: '1', price: item.variant.price.toFixed(2), discount: '', lotId: '' }];
    });
  };
  const edit = (i: number, patch: Partial<Line>) => setCart((old) => old.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const lotsFor = useMemo(() => (variantId: string) => s.balances
    .filter((b) => b.branchId === branchId && b.variantId === variantId && b.lotId && b.quantity > 0)
    .map((b) => ({ ...s.lots.find((l) => l.id === b.lotId)!, quantity: b.quantity }))
    .filter((l) => l.id), [s, branchId]);

  const checkout = () => {
    if (cart.some((l) => n(l.quantity) <= 0)) return setMessage({ kind: 'error', text: 'Revisa las cantidades.' });
    const maxPct = s.settings.maxSellerDiscountPct;
    if (!can('pos.discount') && cart.some((l) => n(l.discount) > round2((n(l.quantity) * n(l.price) * maxPct) / 100) + 0.01)) {
      return setMessage({ kind: 'error', text: `Tu descuento máximo es ${maxPct}% por producto.` });
    }
    if (cart.some((l) => n(l.discount) > round2(n(l.quantity) * n(l.price)))) return setMessage({ kind: 'error', text: 'Un descuento supera el importe.' });
    setPayments([{ method: 'CASH', amount: totals.total.toFixed(2), reference: '' }]);
    setPaying(true);
  };

  const confirmSale = () => run(async () => {
    if (!s.cashSession) throw new Error('Abre la caja antes de vender.');
    if (missing > 0) throw new Error(`Falta cobrar ${money(missing)}.`);
    if (change > cashPaid) throw new Error('Solo el efectivo puede exceder el total (vuelto).');
    for (const p of payments.filter((x) => x.method === 'VOUCHER')) {
      if (!online) throw new Error('Los vales solo se pueden usar con conexión.');
      const v = await api<{ balance: number }>(`vouchers/${encodeURIComponent(p.reference)}`);
      if (v.balance < n(p.amount)) throw new Error(`El vale solo tiene ${money(v.balance)}.`);
    }
    // El vuelto se descuenta del efectivo: se registra lo que realmente queda en caja.
    let toReturn = change;
    const applied = payments.map((p) => {
      let amount = round2(n(p.amount));
      if (p.method === 'CASH' && toReturn > 0) { const t = Math.min(toReturn, amount); amount = round2(amount - t); toReturn = round2(toReturn - t); }
      return { method: p.method, amount, reference: p.reference.trim() };
    }).filter((p) => p.amount > 0);

    const number = await nextNumber();
    const items = cart.map((l) => ({ variantId: l.variantId, quantity: n(l.quantity), unitPrice: round2(n(l.price)), discount: round2(n(l.discount)), lotId: l.lotId || null }));
    const chosen = s.customers.find((c) => c.id === customer.id);
    const isNew = !chosen && customer.name.trim();
    const newCustomer = isNew ? { ...customer, id: crypto.randomUUID(), name: customer.name.trim() } : null;
    const outcome = await submit('sale.create', {
      saleId: crypto.randomUUID(), branchId, series: device!.series, number, cashSessionId: s.cashSession.id,
      customer: newCustomer, customerId: chosen?.id ?? null, items, payments: applied,
    });
    setReceipt({
      series: device!.series, number, occurredAt: new Date().toISOString(), user: user.name, branch: s.branches.find((b) => b.id === branchId)?.name ?? '',
      customer: chosen ?? newCustomer, subtotal: totals.subtotal, discount: totals.discount, total: totals.total, payments: applied, change,
      items: items.map((i, k) => ({ ...i, description: byId.get(i.variantId)!.label, total: totals.lines[k] })), pending: outcome.state === 'queued',
    });
    setCart([]); setPaying(false); setCustomer({ id: '', name: '', docNumber: '', phone: '', email: '' });
  });

  if (!device) return <Page title="Vender"><p className="msg info">Conéctate una vez para asignar a este dispositivo su serie de comprobantes.</p></Page>;

  return (
    <Page title="Vender" actions={<span className="muted">Serie {device.series}</span>}>
      {!s.cashSession && <p className="msg info">La caja está cerrada. <a href="/app/caja">Abre la caja</a> para vender.</p>}
      <div className="pos">
        <section className="stack">
          <ProductPicker onPick={add} autoFocus />
          {!cart.length && <p className="empty">Escanea o busca un producto para empezar.</p>}
          <ul className="cart">
            {cart.map((l, i) => {
              const item = byId.get(l.variantId);
              if (!item) return null;
              const lots = lotsFor(l.variantId);
              const suggested = lots.length ? allocateFefo(lots.map((x) => ({ lotId: x.id, expiresAt: x.expiresAt, quantity: x.quantity })), n(l.quantity)) : [];
              const stock = stockOf(s, branchId, l.variantId);
              return (
                <li key={`${l.variantId}-${i}`} className="card">
                  <div className="row between"><b>{item.label}</b><button className="btn ghost" onClick={() => setCart(cart.filter((_, j) => j !== i))} aria-label={`Quitar ${item.label}`}>✕</button></div>
                  <div className="line-grid">
                    <Field label="Cantidad">
                      <span className="stepper">
                        <button type="button" className="btn" aria-label="Menos" onClick={() => edit(i, { quantity: String(Math.max(1, n(l.quantity) - 1)) })}>−</button>
                        <input inputMode="decimal" value={l.quantity} onChange={(e) => edit(i, { quantity: e.target.value })} />
                        <button type="button" className="btn" aria-label="Más" onClick={() => edit(i, { quantity: String(n(l.quantity) + 1) })}>+</button>
                      </span>
                    </Field>
                    <Field label="Precio"><input inputMode="decimal" value={l.price} readOnly={!can('prices.manage')} onChange={(e) => edit(i, { price: e.target.value })} /></Field>
                    <Field label="Descuento S/"><input inputMode="decimal" value={l.discount} placeholder="0.00" onChange={(e) => edit(i, { discount: e.target.value })} /></Field>
                    <Field label="Importe"><output>{money(totals.lines[i])}</output></Field>
                  </div>
                  {lots.length > 0 && (
                    <Field label="Lote">
                      <select value={l.lotId} onChange={(e) => edit(i, { lotId: e.target.value })}>
                        <option value="">Automático (vence primero): {suggested.map((a) => lots.find((x) => x.id === a.lotId)?.code ?? 'sin lote').join(', ')}</option>
                        {lots.filter((x) => !x.id.startsWith('local:')).map((x) => <option key={x.id} value={x.id}>{x.code} · vence {x.expiresAt ?? '—'} · {x.quantity}</option>)}
                      </select>
                    </Field>
                  )}
                  {n(l.quantity) > stock && <small className="warn-text">Stock en esta sucursal: {stock}</small>}
                </li>
              );
            })}
          </ul>
        </section>
        <aside className="card checkout">
          <dl><div><dt>Subtotal</dt><dd>{money(totals.subtotal)}</dd></div><div><dt>Descuento</dt><dd>{money(totals.discount)}</dd></div><div className="total"><dt>Total</dt><dd>{money(totals.total)}</dd></div></dl>
          <button className="btn primary big" disabled={!cart.length || !s.cashSession} onClick={checkout}>Cobrar</button>
          {!paying && <Notice message={message} />}
        </aside>
      </div>

      {paying && (
        <Modal title={`Cobrar ${money(totals.total)}`} onClose={() => setPaying(false)}>
          {payments.map((p, i) => {
            const set = (patch: Partial<Pay>) => setPayments(payments.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div className="row nowrap end-align" key={i}>
                <Field label="Medio"><select value={p.method} onChange={(e) => set({ method: e.target.value as PaymentMethodT, reference: '' })}>{Object.entries(PAYMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label={p.method === 'CASH' ? 'Recibido' : 'Monto'}><input inputMode="decimal" value={p.amount} onChange={(e) => set({ amount: e.target.value })} /></Field>
                {p.method !== 'CASH' && <Field label={p.method === 'VOUCHER' ? 'Código de vale' : 'N.º operación'}><input value={p.reference} onChange={(e) => set({ reference: e.target.value })} /></Field>}
                {payments.length > 1 && <button type="button" className="btn ghost" aria-label="Quitar pago" onClick={() => setPayments(payments.filter((_, j) => j !== i))}>✕</button>}
              </div>
            );
          })}
          <button type="button" className="btn" onClick={() => setPayments([...payments, { method: 'YAPE', amount: Math.max(0, missing).toFixed(2), reference: '' }])}>+ Pago mixto</button>
          <p className="big-text">{missing > 0 ? `Falta ${money(missing)}` : `Vuelto ${money(change)}`}</p>
          <details>
            <summary>Cliente (opcional)</summary>
            <Field label="Cliente frecuente"><select value={customer.id} onChange={(e) => setCustomer({ ...customer, id: e.target.value })}><option value="">— Nuevo o sin cliente —</option>{s.customers.map((c) => <option key={c.id} value={c.id}>{c.name} {c.docNumber}</option>)}</select></Field>
            {!customer.id && (
              <div className="grid2">
                <Field label="Nombre"><input value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} /></Field>
                <Field label="Documento"><input value={customer.docNumber} onChange={(e) => setCustomer({ ...customer, docNumber: e.target.value })} /></Field>
                <Field label="Celular"><input inputMode="tel" value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} /></Field>
                <Field label="Correo"><input type="email" value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} /></Field>
              </div>
            )}
          </details>
          <Notice message={message} />
          <button className="btn primary big" disabled={busy || missing > 0} onClick={confirmSale}>{busy ? 'Registrando…' : 'Confirmar venta'}</button>
        </Modal>
      )}
      {receipt && (
        <Modal title="Venta registrada" onClose={() => setReceipt(null)}>
          {receipt.pending && <p className="msg info no-print">Guardada en este dispositivo. Se enviará cuando haya conexión.</p>}
          <Receipt data={receipt} settings={s.settings} />
          <button className="btn primary big no-print" onClick={() => setReceipt(null)}>Nueva venta</button>
        </Modal>
      )}
    </Page>
  );
}
