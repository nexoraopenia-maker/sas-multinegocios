'use client';
import { useState } from 'react';
import { api } from '@/client/api';
import { useStore } from '@/client/store';
import { Field, Modal, Notice, Page, useAction } from '@/client/ui/kit';
import type { AttributeDef } from '@/shared/attributes';
import type { CategoryDto } from '@/shared/snapshot';

type Attr = Omit<AttributeDef, 'options'> & { options: string };
const slug = (label: string) => label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);

export default function Categories() {
  const { view, sync, can } = useStore();
  const [editing, setEditing] = useState<CategoryDto | 'new' | null>(null);
  return (
    <Page title="Categorías y atributos" actions={can('catalog.manage') && <button className="btn primary" onClick={() => setEditing('new')}>+ Categoría</button>}>
      <div className="cards wide">{view!.categories.map((c) => (
        <div key={c.id} className="card stack">
          <div className="row between"><h2>{c.name}</h2>{can('catalog.manage') && <button className="btn" onClick={() => setEditing(c)}>Editar</button>}</div>
          <p className="muted">{c.tracksExpiry ? 'Controla vencimiento' : 'Sin vencimiento'}</p>
          <p>{c.attributes.map((a) => <span key={a.key} className="tag">{a.label}{a.perVariant ? '' : ' (producto)'}</span>)}</p>
        </div>
      ))}</div>
      {editing && <Editor category={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { await sync(); setEditing(null); }} />}
    </Page>
  );
}

function Editor({ category, onClose, onSaved }: { category: CategoryDto | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(category?.name ?? '');
  const [expiry, setExpiry] = useState(category?.tracksExpiry ?? false);
  const [attrs, setAttrs] = useState<Attr[]>(category?.attributes.map((a) => ({ ...a, options: a.options.join(', ') })) ?? []);
  const { busy, message, run } = useAction();
  const patch = (i: number, p: Partial<Attr>) => setAttrs(attrs.map((a, j) => (j === i ? { ...a, ...p } : a)));
  return (
    <Modal title={category ? 'Editar categoría' : 'Nueva categoría'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        await api('catalog/categories', { body: { id: category?.id, name, tracksExpiry: expiry, attributes: attrs.map((a) => ({ ...a, key: a.key || slug(a.label), options: a.options.split(',').map((o) => o.trim()).filter(Boolean) })) } });
        await onSaved();
      }); }}>
        <Field label="Nombre"><input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={expiry} onChange={(e) => setExpiry(e.target.checked)} /> Sus productos controlan vencimiento</label>
        <h3>Atributos</h3>
        {attrs.map((a, i) => (
          <div key={i} className="card stack">
            <div className="grid2">
              <Field label="Nombre"><input required value={a.label} onChange={(e) => patch(i, { label: e.target.value })} /></Field>
              <Field label="Tipo"><select value={a.type} onChange={(e) => patch(i, { type: e.target.value as Attr['type'] })}><option value="text">Texto</option><option value="number">Número</option><option value="select">Lista</option></select></Field>
            </div>
            {a.type === 'select' && <Field label="Opciones separadas por coma"><input required value={a.options} onChange={(e) => patch(i, { options: e.target.value })} /></Field>}
            <div className="row between">
              <label className="check"><input type="checkbox" checked={a.perVariant} onChange={(e) => patch(i, { perVariant: e.target.checked })} /> Varía por variante</label>
              <label className="check"><input type="checkbox" checked={a.required} onChange={(e) => patch(i, { required: e.target.checked })} /> Obligatorio</label>
              <button type="button" className="btn ghost" onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}>Quitar</button>
            </div>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setAttrs([...attrs, { key: '', label: '', type: 'text', options: '', required: false, perVariant: true }])}>+ Atributo</button>
        <Notice message={message} />
        <button className="btn primary" disabled={busy}>Guardar</button>
      </form>
    </Modal>
  );
}
