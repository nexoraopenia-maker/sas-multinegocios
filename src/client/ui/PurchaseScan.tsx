'use client';
/** Escaneo de comprobantes: sube el archivo, edita el borrador y confirma el ingreso. */
import { useEffect, useRef, useState } from 'react';
import { validateAttributes } from '@/shared/attributes';
import { money, round2 } from '@/shared/money';
import { matchLine, MAX_SCAN_BYTES, purchaseDocument, SCAN_MIME, type PurchaseRef, type ScanResult } from '@/shared/purchase';
import { DOC_TYPES } from '@/shared/sunat-qr';
import { api } from '../api';
import { useStore } from '../store';
import { Field, Notice, useAction, when } from './kit';
import { ProductPicker, useItems, type Item } from './products';

interface NewProduct { name: string; categoryId: string; price: string; sku: string; barcode: string; tracksExpiry: boolean; attributes: Record<string, string> }
interface Line {
  key: number; description: string; code: string; mode: 'existing' | 'new' | 'skip'; variantId: string; by: 'code' | 'name' | 'manual' | null; candidates: string[];
  quantity: string; unitCost: string; lotCode: string; expiresAt: string; product: NewProduct;
}
interface Head { docType: string; supplierRuc: string; series: string; number: string; issueDate: string; total: string; igv: string }
const n = (v: string) => Number(v.replace(',', '.'));
const optional = (v: string) => (v.trim() === '' ? null : n(v));
const str = (v: number | null) => (v === null ? '' : String(v));

/** Reduce fotos grandes (de celular) para que entren en el límite de subida. */
async function prepare(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.size <= 3_000_000) return file;
  const image = await createImageBitmap(file);
  const scale = Math.min(1, 2200 / Math.max(image.width, image.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(image.width * scale), height: Math.round(image.height * scale) });
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
}

export function PurchaseScan({ onConfirmed }: { onConfirmed: (lines: { variantId: string; quantity: number }[]) => void }) {
  const { view, branchId, online, can, sync, submitOnline } = useStore();
  const { items, byId } = useItems();
  const s = view!;
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [head, setHead] = useState<Head | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [duplicate, setDuplicate] = useState<PurchaseRef | null>(null);
  const { busy, message, run } = useAction();
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const canCreate = can('catalog.manage') && s.categories.length > 0;

  const reset = () => { setScan(null); setHead(null); setLines([]); setDuplicate(null); };

  const upload = (original?: File) => original && run(async () => {
    const file = await prepare(original);
    if (file.size > MAX_SCAN_BYTES) throw new Error('El archivo debe pesar como máximo 4 MB.');
    const form = new FormData();
    form.set('file', file);
    form.set('branchId', branchId);
    const r = await api<ScanResult>('purchases/scan', { form, timeout: 70_000 });
    const d = r.draft;
    const matchable = items.filter((i) => i.variant.active && i.product.active)
      .map((i) => ({ id: i.variant.id, label: i.label, brand: i.product.brand, sku: i.variant.sku, barcode: i.variant.barcode }));
    setScan(r);
    setDuplicate(r.duplicate);
    setHead({ docType: d.docType, supplierRuc: d.supplierRuc, series: d.series, number: d.number, issueDate: d.issueDate, total: str(d.total), igv: str(d.igv) });
    setLines(d.lines.map((l, key) => {
      const m = matchLine(l, matchable);
      return {
        key, description: l.description, code: l.code, mode: 'existing', variantId: m.variantId, by: m.by, candidates: m.candidates,
        quantity: l.quantity ? String(l.quantity) : '', unitCost: str(l.unitCost), lotCode: l.lotCode, expiresAt: l.expiresAt,
        product: {
          // La categoría la elige la persona: una por defecto clasificaría mal el producto.
          name: l.description, categoryId: '', price: '', sku: '', barcode: /^\d{8,14}$/.test(l.code) ? l.code : '',
          tracksExpiry: !!l.expiresAt, attributes: {},
        },
      };
    }));
    if (r.reused) return 'Este archivo ya se había leído: se muestra su borrador sin volver a consumir IA.';
  });

  // Vuelve a comprobar duplicados cuando se editan los datos del comprobante.
  const key = head ? `${head.supplierRuc}|${head.docType}|${head.series}|${head.number}` : '';
  useEffect(() => {
    if (!head?.docType || head.supplierRuc.length !== 11 || !head.series || !head.number) { setDuplicate(null); return; }
    let stale = false;
    const timer = setTimeout(() => {
      const q = new URLSearchParams({ supplierRuc: head.supplierRuc, docType: head.docType, series: head.series, number: head.number });
      api<{ duplicate: PurchaseRef | null }>(`purchases/check?${q}`).then((r) => { if (!stale) setDuplicate(r.duplicate); }).catch(() => {});
    }, 400);
    return () => { stale = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const patch = (k: number, p: Partial<Line>) => setLines((old) => old.map((l) => (l.key === k ? { ...l, ...p } : l)));
  const choose = (k: number, item: Item) => patch(k, { mode: 'existing', variantId: item.variant.id, by: 'manual' });
  const active = lines.filter((l) => l.mode !== 'skip');
  const total = round2(active.reduce((sum, l) => sum + (n(l.quantity) || 0) * (optional(l.unitCost) || 0), 0));
  const used = scan?.status === 'CONFIRMED';

  const confirmEntry = () => run(async () => {
    if (!scan || !head) return;
    if (!active.length) throw new Error('No hay líneas para ingresar.');
    const doc = purchaseDocument({ ...head, total: optional(head.total), igv: optional(head.igv) });
    if (doc.error) throw new Error(doc.error);
    // Todo se valida antes de crear productos, para no dejar altas a medias.
    for (const [i, l] of active.entries()) {
      const where = `Línea ${i + 1} (${l.description || l.code}):`;
      if (!(n(l.quantity) > 0)) throw new Error(`${where} indica la cantidad.`);
      if (l.unitCost.trim() && !(n(l.unitCost) >= 0)) throw new Error(`${where} revisa el costo.`);
      const item = byId.get(l.variantId);
      if (l.mode === 'existing') {
        if (!item) throw new Error(`${where} elige un producto, créalo u omite la línea.`);
        const known = s.lots.some((x) => x.variantId === l.variantId && x.code === l.lotCode.trim());
        if (item.product.tracksExpiry && !l.expiresAt && !known) throw new Error(`${where} indica el vencimiento.`);
      } else {
        const category = s.categories.find((c) => c.id === l.product.categoryId);
        if (!l.product.name.trim() || !category) throw new Error(`${where} completa nombre y categoría del producto nuevo.`);
        if (!l.product.price.trim() || !(n(l.product.price) >= 0)) throw new Error(`${where} indica el precio de venta.`);
        if (l.product.tracksExpiry && !l.expiresAt) throw new Error(`${where} indica el vencimiento.`);
        const errors = [false, true].flatMap((perVariant) => {
          const keys = category.attributes.filter((a) => a.perVariant === perVariant).map((a) => a.key);
          return validateAttributes(category.attributes, Object.fromEntries(Object.entries(l.product.attributes).filter(([k]) => keys.includes(k))), perVariant).errors;
        });
        if (errors.length) throw new Error(`${where} ${errors.join('. ')}`);
      }
    }
    if (doc.document) {
      const found = await api<{ duplicate: PurchaseRef | null }>(`purchases/check?${new URLSearchParams({ supplierRuc: doc.document.supplierRuc, docType: doc.document.docType, series: doc.document.series, number: doc.document.number })}`);
      if (found.duplicate) { setDuplicate(found.duplicate); throw new Error('Ese comprobante ya fue ingresado.'); }
    }

    const created = new Map<string, string>();
    const ready: Line[] = [];
    for (const l of active) {
      if (l.mode !== 'new') { ready.push(l); continue; }
      const p = l.product;
      const category = s.categories.find((c) => c.id === p.categoryId)!;
      // Dos líneas del mismo producto nuevo (p. ej. dos lotes) lo crean una sola vez.
      const same = JSON.stringify([p.name.trim().toLowerCase(), p.categoryId, p.attributes]);
      let variantId = created.get(same);
      if (!variantId) {
        const attrs = (perVariant: boolean) => Object.fromEntries(category.attributes.filter((a) => a.perVariant === perVariant && p.attributes[a.key]).map((a) => [a.key, p.attributes[a.key]]));
        const saved = await api<{ variantIds: string[] }>('catalog/products', { body: {
          categoryId: p.categoryId, name: p.name.trim(), tracksExpiry: p.tracksExpiry, attributes: attrs(false),
          variants: [{ sku: p.sku.trim(), barcode: p.barcode.trim(), attributes: attrs(true), price: round2(n(p.price)) }],
        } });
        variantId = saved.variantIds[0];
        created.set(same, variantId);
      }
      // Si algo falla después, la línea ya apunta al producto creado y no se duplica al reintentar.
      patch(l.key, { mode: 'existing', variantId, by: 'manual' });
      ready.push({ ...l, variantId });
    }
    if (created.size) await sync();

    const reference = doc.document
      ? `${DOC_TYPES[doc.document.docType] ?? 'Comprobante'} ${doc.document.series}-${doc.document.number} · RUC ${doc.document.supplierRuc}`
      : `Archivo ${scan.fileName}`;
    await submitOnline('stock.in', {
      branchId, initial: false, scanId: scan.scanId, document: doc.document,
      reason: `Compra escaneada · ${reference}${scan.draft.supplierName ? ` · ${scan.draft.supplierName}` : ''}`.slice(0, 300),
      items: ready.map((l) => ({ variantId: l.variantId, quantity: n(l.quantity), unitCost: optional(l.unitCost) === null ? null : round2(n(l.unitCost)), lotCode: l.lotCode.trim() || null, expiresAt: l.expiresAt || null })),
    });
    const done = ready.map((l) => ({ variantId: l.variantId, quantity: n(l.quantity) }));
    reset();
    await sync();
    onConfirmed(done);
  });

  if (!online) return <p className="msg info">El escaneo con IA necesita conexión. Puedes registrar el ingreso manualmente.</p>;

  return (
    <div className="stack">
      {!scan && (
        <div className="card stack">
          <h2>Escanear o subir un comprobante</h2>
          <p className="muted">Boleta, factura o lista de compra en JPG, PNG, WEBP o PDF (máximo 4 MB y 10 páginas). La IA prepara un borrador; nada entra al inventario hasta que lo confirmes. El archivo se envía a OpenAI para leerlo.</p>
          <div className="row">
            <button type="button" className="btn primary big" disabled={busy} onClick={() => camera.current?.click()}>📷 Tomar foto</button>
            <button type="button" className="btn big" disabled={busy} onClick={() => picker.current?.click()}>📎 Subir archivo</button>
          </div>
          <input ref={camera} hidden type="file" accept="image/*" capture="environment" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
          <input ref={picker} hidden type="file" aria-label="Archivo del comprobante" accept={SCAN_MIME.join(',')} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
          {busy && <p className="msg info" role="status">Leyendo el comprobante… puede tardar hasta un minuto.</p>}
        </div>
      )}

      {scan && head && (
        <>
          <div className="card stack">
            <div className="row between"><h2>Borrador · {scan.draft.supplierName || 'Proveedor sin nombre'}</h2>
              <span className="row"><a className="btn" href={`/api/purchases/${scan.scanId}/file`} download>Ver archivo</a><button type="button" className="btn ghost" onClick={reset}>Descartar</button></span></div>
            {used && <p className="msg error" role="alert">Este archivo ya se registró en un ingreso. No se puede volver a usar.</p>}
            {duplicate && <p className="msg error" role="alert">Comprobante duplicado: ya se ingresó el {when(duplicate.createdAt)} en {duplicate.branch} por {money(duplicate.total)}.</p>}
            {scan.draft.warnings.map((w) => <p key={w} className="msg info">{w}</p>)}
            <div className="grid3">
              <Field label="Comprobante"><select value={head.docType} onChange={(e) => setHead({ ...head, docType: e.target.value })}><option value="">Sin comprobante (solo archivo)</option><option value="01">Factura</option><option value="03">Boleta</option></select></Field>
              <Field label="RUC del proveedor"><input inputMode="numeric" maxLength={11} value={head.supplierRuc} onChange={(e) => setHead({ ...head, supplierRuc: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="Serie"><input value={head.series} maxLength={10} onChange={(e) => setHead({ ...head, series: e.target.value.toUpperCase() })} /></Field>
              <Field label="Número"><input inputMode="numeric" maxLength={12} value={head.number} onChange={(e) => setHead({ ...head, number: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="Fecha"><input type="date" value={head.issueDate} onChange={(e) => setHead({ ...head, issueDate: e.target.value })} /></Field>
              <Field label="Total"><input inputMode="decimal" value={head.total} onChange={(e) => setHead({ ...head, total: e.target.value })} /></Field>
              <Field label="IGV"><input inputMode="decimal" value={head.igv} onChange={(e) => setHead({ ...head, igv: e.target.value })} /></Field>
            </div>
          </div>

          {lines.map((l, i) => {
            const item = byId.get(l.variantId);
            const category = s.categories.find((c) => c.id === l.product.categoryId);
            const expiry = l.mode === 'new' ? l.product.tracksExpiry : !!item?.product.tracksExpiry;
            const setProduct = (p: Partial<NewProduct>) => patch(l.key, { product: { ...l.product, ...p } });
            return (
              <div key={l.key} className={`card stack ${l.mode === 'skip' ? 'dim' : ''}`}>
                <div className="row between"><b>{i + 1}. {l.description || l.code}</b>{l.code && <span className="tag">{l.code}</span>}</div>
                <div className="tabs" role="group" aria-label="Qué hacer con la línea">
                  <button type="button" className="btn" aria-pressed={l.mode === 'existing'} onClick={() => patch(l.key, { mode: 'existing' })}>Producto existente</button>
                  {canCreate && <button type="button" className="btn" aria-pressed={l.mode === 'new'} onClick={() => patch(l.key, { mode: 'new' })}>Crear producto</button>}
                  <button type="button" className="btn" aria-pressed={l.mode === 'skip'} onClick={() => patch(l.key, { mode: 'skip' })}>Omitir</button>
                </div>
                {l.mode === 'existing' && (item
                  ? <div className="row between"><span><b>{item.label}</b> <span className={`tag ${l.by === 'name' ? 'warn' : 'ok'}`}>{l.by === 'code' ? 'Coincide el código' : l.by === 'name' ? 'Sugerido: revisa' : 'Elegido'}</span><small>{item.variant.sku}</small></span><button type="button" className="btn" onClick={() => patch(l.key, { variantId: '', by: null })}>Cambiar</button></div>
                  : <>
                    {l.candidates.length > 0 && <div className="row">{l.candidates.map((id) => { const c = byId.get(id); return c ? <button key={id} type="button" className="btn" onClick={() => choose(l.key, c)}>{c.label}</button> : null; })}</div>}
                    {!l.candidates.length && <p className="muted">Sin coincidencias. Búscalo{canCreate ? ' o créalo' : ''}.</p>}
                    <ProductPicker onPick={(it) => choose(l.key, it)} />
                  </>)}
                {l.mode === 'new' && (
                  <div className="grid3">
                    <Field label="Nombre *"><input value={l.product.name} onChange={(e) => setProduct({ name: e.target.value })} /></Field>
                    <Field label="Categoría *"><select value={l.product.categoryId} onChange={(e) => setProduct({ categoryId: e.target.value, attributes: {}, tracksExpiry: !!l.expiresAt || !!s.categories.find((c) => c.id === e.target.value)?.tracksExpiry })}><option value="">— Elige —</option>{s.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
                    <Field label="Precio de venta *"><input inputMode="decimal" value={l.product.price} onChange={(e) => setProduct({ price: e.target.value })} /></Field>
                    <Field label="SKU" hint="Vacío: se genera"><input value={l.product.sku} onChange={(e) => setProduct({ sku: e.target.value })} /></Field>
                    <Field label="Código de barras" hint="Vacío: se genera"><input value={l.product.barcode} onChange={(e) => setProduct({ barcode: e.target.value })} /></Field>
                    {category?.attributes.map((a) => (
                      <Field key={a.key} label={`${a.label}${a.required ? ' *' : ''}`}>
                        {a.type === 'select'
                          ? <select value={l.product.attributes[a.key] ?? ''} onChange={(e) => setProduct({ attributes: { ...l.product.attributes, [a.key]: e.target.value } })}><option value="">—</option>{a.options.map((o) => <option key={o}>{o}</option>)}</select>
                          : <input value={l.product.attributes[a.key] ?? ''} onChange={(e) => setProduct({ attributes: { ...l.product.attributes, [a.key]: e.target.value } })} />}
                      </Field>
                    ))}
                    <label className="check"><input type="checkbox" checked={l.product.tracksExpiry} onChange={(e) => setProduct({ tracksExpiry: e.target.checked })} /> Controla vencimiento</label>
                  </div>
                )}
                {l.mode !== 'skip' && (
                  <div className="line-grid">
                    <Field label="Cantidad"><input inputMode="decimal" value={l.quantity} onChange={(e) => patch(l.key, { quantity: e.target.value })} /></Field>
                    <Field label="Costo unitario"><input inputMode="decimal" value={l.unitCost} onChange={(e) => patch(l.key, { unitCost: e.target.value })} /></Field>
                    {(expiry || l.expiresAt || l.lotCode) && <>
                      <Field label={expiry ? 'Vence *' : 'Vence'}><input type="date" value={l.expiresAt} onChange={(e) => patch(l.key, { expiresAt: e.target.value })} /></Field>
                      <Field label="Lote"><input value={l.lotCode} placeholder="Opcional" onChange={(e) => patch(l.key, { lotCode: e.target.value })} /></Field>
                    </>}
                  </div>
                )}
              </div>
            );
          })}

          <div className="card stack">
            <p>Costo de las líneas a ingresar: <b>{money(total)}</b>{optional(head.total) !== null && Math.abs(total - n(head.total)) > 0.01 && <span className="warn-text"> · difiere del total del comprobante ({money(n(head.total))}). Revisa si los costos incluyen IGV.</span>}</p>
            <button type="button" className="btn primary big" disabled={busy || used || !!duplicate} onClick={confirmEntry}>{busy ? 'Registrando…' : `Confirmar ingreso (${active.length})`}</button>
          </div>
        </>
      )}
      <Notice message={message} />
    </div>
  );
}
