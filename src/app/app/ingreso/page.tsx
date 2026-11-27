'use client';
import { useState } from 'react';
import { useStore } from '@/client/store';
import { Field, Notice, Page, useAction } from '@/client/ui/kit';
import { ProductPicker, useItems, type Item } from '@/client/ui/products';
import { ScanButton } from '@/client/ui/Scanner';
import { DOC_TYPES, parseSunatQr, type SunatQr } from '@/shared/sunat-qr';
import { money, round2 } from '@/shared/money';

interface Line { variantId: string; quantity: string; unitCost: string; lotCode: string; expiresAt: string }
const n = (v: string) => Number(v.replace(',', '.')) || 0;

export default function StockIn() {
  const { branchId, submit, view, can } = useStore();
  const { byId } = useItems();
  const [lines, setLines] = useState<Line[]>([]);
  const [reason, setReason] = useState('Ingreso de mercadería');
  const [doc, setDoc] = useState<SunatQr | null>(null);
  const [qrText, setQrText] = useState('');
  const { busy, message, setMessage, run } = useAction();

  const add = (item: Item) => setLines((old) => {
    const i = old.findIndex((l) => l.variantId === item.variant.id);
    if (i >= 0 && !item.product.tracksExpiry) return old.map((l, j) => (j === i ? { ...l, quantity: String(n(l.quantity) + 1) } : l));
    return [...old, { variantId: item.variant.id, quantity: '1', unitCost: item.variant.cost ? String(item.variant.cost) : '', lotCode: '', expiresAt: '' }];
  });
  const patch = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const readQr = (text: string) => {
    const parsed = parseSunatQr(text);
    if (!parsed) return setMessage({ kind: 'error', text: 'Ese código no es el QR de una boleta o factura electrónica.' });
    setDoc(parsed); setQrText(''); setMessage({ kind: 'info', text: 'Comprobante leído. El QR no incluye el detalle: agrega los productos recibidos.' });
  };
  const total = round2(lines.reduce((s, l) => s + n(l.quantity) * n(l.unitCost), 0));

  return (
    <Page title="Ingreso de mercadería" actions={can('catalog.manage') && <><a className="btn" href="/app/producto">Producto nuevo</a><a className="btn" href="/app/importar">Carga masiva</a></>}>
      <div className="card stack">
        <h2>Comprobante del proveedor (opcional)</h2>
        <div className="row nowrap">
          <input className="grow" placeholder="Escanea el QR o pega su contenido" value={qrText} aria-label="Contenido del QR" onChange={(e) => setQrText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); readQr(qrText); } }} />
          <ScanButton label="Escanear QR" onCode={readQr} />
        </div>
        {doc && <p className="msg ok">{DOC_TYPES[doc.docType] ?? doc.docType} {doc.series}-{doc.number} · RUC {doc.supplierRuc} · Total {money(doc.total)} · IGV {money(doc.igv)} {doc.issueDate} <button className="btn ghost" onClick={() => setDoc(null)}>Quitar</button></p>}
      </div>
      <ProductPicker onPick={add} onlyActive={false} />
      {lines.map((l, i) => {
        const item = byId.get(l.variantId);
        if (!item) return null;
        return (
          <div key={`${l.variantId}-${i}`} className="card stack">
            <div className="row between"><b>{item.label}</b><button className="btn ghost" aria-label="Quitar" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></div>
            <div className="line-grid">
              <Field label="Cantidad"><input inputMode="decimal" value={l.quantity} onChange={(e) => patch(i, { quantity: e.target.value })} /></Field>
              <Field label="Costo unitario"><input inputMode="decimal" value={l.unitCost} onChange={(e) => patch(i, { unitCost: e.target.value })} /></Field>
              {item.product.tracksExpiry && <>
                <Field label="Vence *"><input type="date" value={l.expiresAt} onChange={(e) => patch(i, { expiresAt: e.target.value })} /></Field>
                <Field label="Lote"><input value={l.lotCode} placeholder="Opcional" onChange={(e) => patch(i, { lotCode: e.target.value })} /></Field>
              </>}
            </div>
          </div>
        );
      })}
      {lines.length > 0 && (
        <div className="card stack">
          <Field label="Motivo"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {total > 0 && <p>Costo total: <b>{money(total)}</b>{doc && Math.abs(total - doc.total) > 0.01 && <span className="warn-text"> · difiere del comprobante ({money(doc.total)})</span>}</p>}
          <button className="btn primary big" disabled={busy} onClick={() => run(async () => {
            if (lines.some((l) => n(l.quantity) <= 0)) throw new Error('Revisa las cantidades.');
            const without = lines.find((l) => byId.get(l.variantId)?.product.tracksExpiry && !l.expiresAt && !view!.lots.some((x) => x.variantId === l.variantId && x.code === l.lotCode));
            if (without) throw new Error(`Indica el vencimiento de ${byId.get(without.variantId)?.label}.`);
            const r = await submit('stock.in', { branchId, reason, initial: false, document: doc, items: lines.map((l) => ({ variantId: l.variantId, quantity: n(l.quantity), unitCost: l.unitCost === '' ? null : round2(n(l.unitCost)), lotCode: l.lotCode.trim() || null, expiresAt: l.expiresAt || null })) });
            setLines([]); setDoc(null);
            return r.state === 'queued' ? 'Ingreso guardado en el dispositivo. Se sincronizará al volver la conexión.' : 'Ingreso registrado';
          })}>Registrar ingreso</button>
        </div>
      )}
      <Notice message={message} />
    </Page>
  );
}
