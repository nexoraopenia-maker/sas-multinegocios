'use client';
import bwip from 'bwip-js/browser';
import { useMemo, useState } from 'react';
import { useStore } from '@/client/store';
import { Field, Page, useQueryParam } from '@/client/ui/kit';
import { ProductPicker, useItems, type Item } from '@/client/ui/products';
import { isEan13 } from '@/shared/codes';
import { money } from '@/shared/money';
import type { LabelFormat } from '@/shared/snapshot';

function Code({ value, symbol }: { value: string; symbol: LabelFormat['symbol'] }) {
  const svg = useMemo(() => {
    // EAN-13 solo admite códigos numéricos válidos; los demás se imprimen como Code 128.
    const bcid = symbol === 'ean13' && !isEan13(value) ? 'code128' : symbol;
    try { return bwip.toSVG({ bcid, text: value, scale: 2, ...(bcid === 'qrcode' ? {} : { height: 10, includetext: true, textsize: 8 }) }); }
    catch { return ''; }
  }, [value, symbol]);
  // eslint-disable-next-line @next/next/no-img-element
  return svg ? <img className="code" alt={value} src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} /> : <small>{value}</small>;
}

export default function Labels() {
  const productId = useQueryParam('p');
  const { view } = useStore();
  const { items, byId } = useItems();
  const [chosen, setChosen] = useState<Record<string, number> | null>(null);
  const [format, setFormat] = useState<LabelFormat>(view!.settings.labelFormat);
  const copies = chosen ?? Object.fromEntries(items.filter((i) => i.product.id === productId).map((i) => [i.variant.id, 1]));
  const add = (i: Item) => setChosen({ ...copies, [i.variant.id]: (copies[i.variant.id] ?? 0) + 1 });
  const labels = Object.entries(copies).flatMap(([id, count]) => {
    const item = byId.get(id);
    return item ? Array.from({ length: Math.min(count, 500) }, (_, k) => ({ item, key: `${id}-${k}` })) : [];
  });
  return (
    <Page title="Etiquetas" actions={<button className="btn primary" disabled={!labels.length} onClick={() => window.print()}>🖨️ Imprimir {labels.length}</button>}>
      <style>{`@page{margin:5mm}`}</style>
      <div className="card grid3 no-print">
        <Field label="Código"><select value={format.symbol} onChange={(e) => setFormat({ ...format, symbol: e.target.value as LabelFormat['symbol'] })}><option value="code128">Código de barras (Code 128)</option><option value="ean13">EAN-13</option><option value="qrcode">QR</option></select></Field>
        {([['widthMm', 'Ancho (mm)'], ['heightMm', 'Alto (mm)'], ['columns', 'Columnas']] as const).map(([k, label]) => <Field key={k} label={label}><input type="number" min={1} value={format[k]} onChange={(e) => setFormat({ ...format, [k]: Math.max(1, Number(e.target.value)) })} /></Field>)}
        {([['showName', 'Nombre'], ['showPrice', 'Precio'], ['showSku', 'SKU']] as const).map(([k, label]) => <label key={k} className="check"><input type="checkbox" checked={format[k]} onChange={(e) => setFormat({ ...format, [k]: e.target.checked })} /> {label}</label>)}
      </div>
      <ProductPicker onPick={add} onlyActive={false} />
      <div className="no-print">{Object.entries(copies).map(([id, count]) => (
        <div key={id} className="row between card"><span>{byId.get(id)?.label}</span>
          <input className="qty" type="number" min={0} max={500} aria-label="Copias" value={count} onChange={(e) => setChosen({ ...copies, [id]: Number(e.target.value) })} /></div>
      ))}</div>
      <div className="labels print-area" style={{ gridTemplateColumns: `repeat(${format.columns}, ${format.widthMm}mm)` }}>
        {labels.map(({ item, key }) => (
          <div key={key} className="label" style={{ width: `${format.widthMm}mm`, height: `${format.heightMm}mm` }}>
            {format.showName && <span className="name">{item.label}</span>}
            <Code value={item.variant.barcode} symbol={format.symbol} />
            <span>{format.showSku && item.variant.sku} {format.showPrice && <b>{money(item.variant.price)}</b>}</span>
          </div>
        ))}
      </div>
    </Page>
  );
}
