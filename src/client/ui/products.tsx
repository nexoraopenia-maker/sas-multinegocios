'use client';
import { useMemo, useState } from 'react';
import { round3 } from '@/shared/money';
import { variantLabel, type ProductDto, type Snapshot, type VariantDto } from '@/shared/snapshot';
import { useStore } from '../store';
import { ScanButton } from './Scanner';

export interface Item { variant: VariantDto; product: ProductDto; label: string; search: string }

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function buildItems(view: Snapshot): Item[] {
  const products = new Map(view.products.map((p) => [p.id, p]));
  return view.variants.flatMap((variant) => {
    const product = products.get(variant.productId);
    if (!product) return [];
    const label = variantLabel(product, variant);
    return [{ variant, product, label, search: fold([label, product.brand, variant.sku, variant.barcode, ...Object.values(product.attributes ?? {})].join(' ')) }];
  });
}

export function useItems() {
  const { view } = useStore();
  const items = useMemo(() => (view ? buildItems(view) : []), [view]);
  const byId = useMemo(() => new Map(items.map((i) => [i.variant.id, i])), [items]);
  return { items, byId };
}

export const stockOf = (view: Snapshot, branchId: string, variantId: string) =>
  round3(view.balances.filter((b) => b.branchId === branchId && b.variantId === variantId).reduce((s, b) => s + b.quantity, 0));

export function findItems(items: Item[], query: string) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return items.filter((i) => words.every((w) => i.search.includes(w)));
}

export const findByCode = (items: Item[], code: string) => {
  const c = code.trim().toLowerCase();
  return items.find((i) => i.variant.barcode.toLowerCase() === c || i.variant.sku.toLowerCase() === c);
};

/** Búsqueda manual, lector físico (escribe y pulsa Enter) o cámara. */
export function ProductPicker({ onPick, onlyActive = true, autoFocus = false }: { onPick: (item: Item) => void; onlyActive?: boolean; autoFocus?: boolean }) {
  const { view, branchId } = useStore();
  const { items } = useItems();
  const [query, setQuery] = useState('');
  const [missing, setMissing] = useState('');
  const pool = onlyActive ? items.filter((i) => i.variant.active && i.product.active) : items;
  const results = query.trim() ? findItems(pool, query).slice(0, 12) : [];

  const pick = (item: Item) => { onPick(item); setQuery(''); setMissing(''); };
  const byCode = (code: string) => {
    const item = findByCode(pool, code);
    if (item) pick(item);
    else { setMissing(`No hay ningún producto con el código ${code}`); setQuery(''); }
  };

  return (
    <div className="picker no-print">
      <div className="row nowrap">
        <input
          type="search" className="grow" placeholder="Buscar o escanear producto…" value={query} autoFocus={autoFocus} aria-label="Buscar producto"
          onChange={(e) => { setQuery(e.target.value); setMissing(''); }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const exact = findByCode(pool, query);
            if (exact) pick(exact); else if (results.length === 1) pick(results[0]); else if (!results.length && query.trim()) byCode(query.trim());
          }}
        />
        <ScanButton onCode={byCode} keepOpen />
      </div>
      {missing && <p className="msg error">{missing}</p>}
      {results.length > 0 && view && (
        <ul className="results">
          {results.map((i) => (
            <li key={i.variant.id}>
              <button type="button" onClick={() => pick(i)}>
                <span><b>{i.label}</b><small>{i.variant.sku}</small></span>
                <span className="end"><b>S/ {i.variant.price.toFixed(2)}</b><small>Stock: {stockOf(view, branchId, i.variant.id)}</small></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
