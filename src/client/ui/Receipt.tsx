'use client';
import { useState } from 'react';
import { receiptNumber } from '@/shared/codes';
import { money } from '@/shared/money';
import { PAYMENT_LABELS, type PaymentMethodT } from '@/shared/operations';
import type { SettingsDto } from '@/shared/snapshot';
import { when } from './kit';

export interface ReceiptData {
  series: string; number: number; occurredAt: string; status?: string; user: string; branch: string;
  customer?: { name: string; docNumber: string; phone: string; email: string } | null;
  items: { description: string; quantity: number; unitPrice: number; discount: number; total: number }[];
  subtotal: number; discount: number; total: number; payments: { method: PaymentMethodT; amount: number }[]; change?: number; pending?: boolean;
}

const asText = (r: ReceiptData, s: SettingsDto) => [
  s.legalName, `Comprobante interno ${receiptNumber(r.series, r.number)}`, when(r.occurredAt),
  ...r.items.map((i) => `${i.quantity} x ${i.description}: ${money(i.total)}`), `TOTAL: ${money(r.total)}`, s.ticketFooter,
].filter(Boolean).join('\n');

export function Receipt({ data, settings }: { data: ReceiptData; settings: SettingsDto }) {
  const [format, setFormat] = useState<'ticket' | 'a4'>('ticket');
  const share = encodeURIComponent(asText(data, settings));
  const phone = data.customer?.phone.replace(/\D/g, '') ?? '';
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;
  // CSS no admite alto automático de página: se estima según las líneas del ticket.
  const ticketHeight = 95 + data.items.reduce((h, i) => h + 6 + Math.floor(i.description.length / 22) * 4 + (i.discount > 0 ? 4 : 0), 0) + data.payments.length * 5;
  const sharing = (href: string, label: string) => offline
    ? <button type="button" className="btn" disabled title="Requiere conexión">{label} (sin conexión)</button>
    : <a className="btn" href={href} target="_blank" rel="noreferrer">{label}</a>;
  return (
    <div className="stack">
      <style>{format === 'ticket' ? `@page{size:80mm ${ticketHeight}mm;margin:3mm}` : '@page{size:A4;margin:15mm}'}</style>
      <div className="row no-print">
        <select value={format} onChange={(e) => setFormat(e.target.value as 'ticket' | 'a4')} aria-label="Formato"><option value="ticket">Ticket 80 mm</option><option value="a4">A4</option></select>
        <button type="button" className="btn primary" onClick={() => window.print()}>🖨️ Imprimir</button>
        {sharing(`https://wa.me/${phone.length === 9 ? `51${phone}` : phone}?text=${share}`, 'WhatsApp')}
        {sharing(`mailto:${data.customer?.email ?? ''}?subject=${encodeURIComponent(`Comprobante ${receiptNumber(data.series, data.number)}`)}&body=${share}`, 'Correo')}
      </div>
      <article className={`receipt print-area ${format}`}>
        <header><b>{settings.legalName}</b>{settings.taxId && <div>RUC {settings.taxId}</div>}<div>{data.branch}</div></header>
        <p><b>COMPROBANTE INTERNO {receiptNumber(data.series, data.number)}</b><br />{when(data.occurredAt)} · {data.user}
          {data.customer && <><br />Cliente: {data.customer.name} {data.customer.docNumber}</>}
          {data.status === 'VOIDED' && <><br /><b>*** ANULADO ***</b></>}
        </p>
        <table><thead><tr><th>Cant.</th><th>Descripción</th><th className="num">P. unit.</th><th className="num">Importe</th></tr></thead>
          <tbody>{data.items.map((i, n) => <tr key={n}><td>{i.quantity}</td><td>{i.description}{i.discount > 0 && <small>Desc. {money(i.discount)}</small>}</td><td className="num">{i.unitPrice.toFixed(2)}</td><td className="num">{i.total.toFixed(2)}</td></tr>)}</tbody>
        </table>
        <dl>
          <div><dt>Subtotal</dt><dd>{money(data.subtotal)}</dd></div>
          {data.discount > 0 && <div><dt>Descuento</dt><dd>-{money(data.discount)}</dd></div>}
          <div className="total"><dt>TOTAL</dt><dd>{money(data.total)}</dd></div>
          {data.payments.map((p, n) => <div key={n}><dt>{PAYMENT_LABELS[p.method]}</dt><dd>{money(p.amount)}</dd></div>)}
          {!!data.change && <div><dt>Vuelto</dt><dd>{money(data.change)}</dd></div>}
        </dl>
        <footer>{settings.ticketFooter}<br /><small>Documento sin valor tributario.</small></footer>
      </article>
    </div>
  );
}
