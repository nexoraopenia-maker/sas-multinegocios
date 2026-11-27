'use client';
import { useEffect, useState } from 'react';
import { api } from '@/client/api';
import { useStore } from '@/client/store';
import { Empty, Field, Page, useLoad, useQueryParam, when } from '@/client/ui/kit';
import { ProductPicker, stockOf, useItems } from '@/client/ui/products';
import { addDays, todayISO } from '@/shared/stock';

type Move = { id: string; variantId: string; lotId: string | null; type: string; quantity: number; reason: string; user: string; occurredAt: string };
const TYPES: Record<string, string> = { PURCHASE: 'Entrada', INITIAL: 'Stock inicial', SALE: 'Venta', SALE_VOID: 'Anulación', RETURN: 'Devolución', ADJUSTMENT: 'Ajuste', COUNT: 'Conteo', WASTE: 'Merma', TRANSFER_OUT: 'Traslado (salida)', TRANSFER_IN: 'Traslado (entrada)' };

export default function Kardex() {
  const param = useQueryParam('v');
  const { branchId, view, lastSync, user } = useStore();
  const { byId } = useItems();
  const [variantId, setVariantId] = useState('');
  const [from, setFrom] = useState(addDays(todayISO(), -30));
  const [to, setTo] = useState(todayISO());
  useEffect(() => { if (param) setVariantId(param); }, [param]);
  const mine = user.branchIds.includes(branchId);
  const { data, error } = useLoad(() => api<Move[]>(`inventory/kardex?branchId=${branchId}&from=${from}&to=${to}${variantId ? `&variantId=${variantId}` : ''}`), [branchId, from, to, variantId, lastSync, mine]);
  return (
    <Page title="Kárdex">
      <ProductPicker onPick={(i) => setVariantId(i.variant.id)} onlyActive={false} />
      {variantId && <p className="card row between"><span><b>{byId.get(variantId)?.label}</b> · Stock actual: {stockOf(view!, branchId, variantId)}</span><button className="btn ghost" onClick={() => setVariantId('')}>Ver todos</button></p>}
      <div className="row"><Field label="Desde"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="Hasta"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
      {error && <p className="msg info">{error}</p>}
      {data && (
        <div className="table-wrap"><table>
          <thead><tr><th>Fecha</th><th>Producto</th><th>Tipo</th><th className="num">Cantidad</th><th>Lote</th><th>Motivo</th><th>Usuario</th></tr></thead>
          <tbody>{data.map((m) => <tr key={m.id}><td>{when(m.occurredAt)}</td><td>{byId.get(m.variantId)?.label}</td><td>{TYPES[m.type] ?? m.type}</td><td className={`num ${m.quantity < 0 ? 'neg' : 'pos-text'}`}>{m.quantity > 0 ? '+' : ''}{m.quantity}</td><td>{view!.lots.find((l) => l.id === m.lotId)?.code ?? ''}</td><td>{m.reason}</td><td>{m.user}</td></tr>)}</tbody>
        </table>{!data.length && <Empty>Sin movimientos en estas fechas.</Empty>}{data.length === 500 && <p className="muted">Se muestran los 500 más recientes. Reduce el rango.</p>}</div>
      )}
    </Page>
  );
}
