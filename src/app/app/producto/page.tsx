'use client';
import { useState } from 'react';
import { api } from '@/client/api';
import { useStore } from '@/client/store';
import { Field, Notice, Page, useAction, useQueryParam } from '@/client/ui/kit';
import { ScanButton } from '@/client/ui/Scanner';
import type { AttributeDef } from '@/shared/attributes';
import type { Snapshot } from '@/shared/snapshot';

type Values = Record<string, string>;
interface VariantForm { id?: string; sku: string; barcode: string; attributes: Values; price: string; cost: string; minStock: string; active: boolean; initialStock: string; expiresAt: string; lotCode: string }
const empty = (): VariantForm => ({ sku: '', barcode: '', attributes: {}, price: '', cost: '', minStock: '0', active: true, initialStock: '', expiresAt: '', lotCode: '' });
const n = (v: string) => Number(v.replace(',', '.'));
const text = (a: Record<string, string | number>) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, String(v)]));

export default function ProductPage() {
  const id = useQueryParam('id');
  const { view } = useStore();
  if (id === undefined) return null;
  if (id && !view!.products.some((p) => p.id === id)) return <Page title="Producto"><p className="empty">Producto no encontrado.</p></Page>;
  return <ProductForm key={id ?? 'new'} id={id} view={view!} />;
}

function AttributeInput({ def, value, onChange }: { def: AttributeDef; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={`${def.label}${def.required ? ' *' : ''}`}>
      {def.type === 'select'
        ? <select value={value} required={def.required} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{def.options.map((o) => <option key={o}>{o}</option>)}</select>
        : <input inputMode={def.type === 'number' ? 'decimal' : 'text'} required={def.required} value={value} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

function ProductForm({ id, view }: { id: string | null; view: Snapshot }) {
  const { branchId, can, online, sync } = useStore();
  const existing = view.products.find((p) => p.id === id);
  const [form, setForm] = useState(() => ({
    categoryId: existing?.categoryId ?? view.categories[0]?.id ?? '', name: existing?.name ?? '', brand: existing?.brand ?? '', description: existing?.description ?? '',
    tracksExpiry: existing?.tracksExpiry ?? view.categories[0]?.tracksExpiry ?? false, active: existing?.active ?? true, attributes: text(existing?.attributes ?? {}),
  }));
  const [variants, setVariants] = useState<VariantForm[]>(() => existing
    ? view.variants.filter((v) => v.productId === id).map((v) => ({ ...empty(), id: v.id, sku: v.sku, barcode: v.barcode, attributes: text(v.attributes), price: String(v.price), cost: v.cost === null ? '' : String(v.cost), minStock: String(v.minStock), active: v.active }))
    : [empty()]);
  const { busy, message, run } = useAction();
  const category = view.categories.find((c) => c.id === form.categoryId);
  const productDefs = category?.attributes.filter((a) => !a.perVariant) ?? [];
  const variantDefs = category?.attributes.filter((a) => a.perVariant) ?? [];
  const patch = (i: number, p: Partial<VariantForm>) => setVariants((old) => old.map((v, j) => (j === i ? { ...v, ...p } : v)));
  const pick = (values: Values, defs: AttributeDef[]) => Object.fromEntries(defs.map((d) => [d.key, values[d.key] ?? '']).filter(([, v]) => v !== ''));

  const save = () => run(async () => {
    const r = await api<{ id: string }>('catalog/products', { body: {
      ...form, id: id ?? undefined, branchId, attributes: pick(form.attributes, productDefs),
      variants: variants.map((v) => ({
        id: v.id, sku: v.sku, barcode: v.barcode, attributes: pick(v.attributes, variantDefs), price: n(v.price),
        cost: v.cost === '' ? undefined : n(v.cost), minStock: n(v.minStock || '0'), active: v.active,
        ...(!v.id && n(v.initialStock) > 0 ? { initialStock: n(v.initialStock), expiresAt: v.expiresAt || undefined, lotCode: v.lotCode || undefined } : {}),
      })),
    } });
    await sync();
    location.href = `/app/producto?id=${r.id}`;
    return 'Producto guardado';
  });

  return (
    <Page title={id ? 'Editar producto' : 'Nuevo producto'} actions={<><a className="btn" href="/app/inventario">Volver</a>{id && <a className="btn" href={`/app/etiquetas?p=${id}`}>Etiquetas</a>}</>}>
      {!online && <p className="msg info">Crear o editar productos requiere conexión.</p>}
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="card grid3">
          <Field label="Categoría"><select value={form.categoryId} onChange={(e) => { const c = view.categories.find((x) => x.id === e.target.value); setForm({ ...form, categoryId: e.target.value, tracksExpiry: c?.tracksExpiry ?? false }); }}>{view.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Nombre *"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Marca"><input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} /></Field>
          {productDefs.map((d) => <AttributeInput key={d.key} def={d} value={form.attributes[d.key] ?? ''} onChange={(v) => setForm({ ...form, attributes: { ...form.attributes, [d.key]: v } })} />)}
          <Field label="Descripción"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={form.tracksExpiry} onChange={(e) => setForm({ ...form, tracksExpiry: e.target.checked })} /> Controla fecha de vencimiento</label>
          <label className="check"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Activo</label>
        </div>
        <h2>Variantes</h2>
        {variants.map((v, i) => (
          <div className="card stack" key={v.id ?? `n${i}`}>
            <div className="grid3">
              {variantDefs.map((d) => <AttributeInput key={d.key} def={d} value={v.attributes[d.key] ?? ''} onChange={(x) => patch(i, { attributes: { ...v.attributes, [d.key]: x } })} />)}
              <Field label="Precio de venta *"><input required inputMode="decimal" readOnly={!!v.id && !can('prices.manage')} value={v.price} onChange={(e) => patch(i, { price: e.target.value })} /></Field>
              <Field label="Costo"><input inputMode="decimal" value={v.cost} onChange={(e) => patch(i, { cost: e.target.value })} /></Field>
              <Field label="Stock mínimo"><input inputMode="decimal" value={v.minStock} onChange={(e) => patch(i, { minStock: e.target.value })} /></Field>
              <Field label="SKU" hint="Vacío: se genera"><input value={v.sku} onChange={(e) => patch(i, { sku: e.target.value })} /></Field>
              <Field label="Código de barras / QR" hint="Vacío: se genera"><span className="row nowrap"><input className="grow" value={v.barcode} onChange={(e) => patch(i, { barcode: e.target.value })} /><ScanButton label="" onCode={(code) => patch(i, { barcode: code })} /></span></Field>
              {!v.id && can('stock.in') && <Field label="Stock inicial (sucursal actual)"><input inputMode="decimal" value={v.initialStock} onChange={(e) => patch(i, { initialStock: e.target.value })} /></Field>}
              {!v.id && form.tracksExpiry && n(v.initialStock) > 0 && <>
                <Field label="Vence *"><input type="date" required value={v.expiresAt} onChange={(e) => patch(i, { expiresAt: e.target.value })} /></Field>
                <Field label="Lote"><input value={v.lotCode} onChange={(e) => patch(i, { lotCode: e.target.value })} /></Field>
              </>}
            </div>
            <div className="row between"><label className="check"><input type="checkbox" checked={v.active} onChange={(e) => patch(i, { active: e.target.checked })} /> Variante activa</label>
              {!v.id && variants.length > 1 && <button type="button" className="btn ghost" onClick={() => setVariants(variants.filter((_, j) => j !== i))}>Quitar</button>}</div>
          </div>
        ))}
        <div className="row">
          <button type="button" className="btn" onClick={() => setVariants([...variants, { ...empty(), price: variants.at(-1)?.price ?? '', cost: variants.at(-1)?.cost ?? '' }])}>+ Variante</button>
          <button className="btn primary" disabled={busy || !online}>Guardar producto</button>
        </div>
        <Notice message={message} />
      </form>
    </Page>
  );
}
