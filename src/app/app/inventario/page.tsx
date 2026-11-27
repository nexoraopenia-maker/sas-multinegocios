'use client';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/client/store';
import { Empty, Page, useQueryParam } from '@/client/ui/kit';
import { findItems, stockOf, useItems } from '@/client/ui/products';
import { ScanButton } from '@/client/ui/Scanner';
import { availableFilters, filterVariants, isStockFilter, STOCK_FILTERS, type StockFilter } from '@/shared/inventory-filters';
import { money } from '@/shared/money';
import { alertSwitches } from '@/shared/snapshot';

export default function Inventory() {
  const { view, branchId, can, user } = useStore();
  const { items } = useItems();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const s = view!;
  const others = s.branches.filter((b) => b.id !== branchId);
  const [filter, setFilter] = useState<StockFilter>('all');
  const filterParam = useQueryParam('f');
  const switches = alertSwitches(user.features, s.settings);
  const filters = availableFilters(switches, can('alerts.view'));
  useEffect(() => { if (filterParam && isStockFilter(filterParam)) setFilter(filterParam); }, [filterParam]);
  const applied = filters.includes(filter) ? filter : 'all';
  const matching = useMemo(() => filterVariants(s, branchId, applied, alertSwitches(user.features, s.settings)), [s, branchId, applied, user.features]);
  const rows = findItems(items, query).filter((i) => (!category || i.product.categoryId === category) && (!matching || matching.has(i.variant.id)));

  return (
    <Page title="Inventario" actions={can('catalog.manage') && (<>
      <a className="btn primary" href="/app/producto">+ Producto</a><a className="btn" href="/app/importar">Carga masiva</a><a className="btn" href="/app/categorias">Categorías</a>
    </>)}>
      <div className="row nowrap">
        <input type="search" className="grow" placeholder="Buscar por nombre, SKU, código, talla…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar" />
        <ScanButton onCode={setQuery} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Categoría"><option value="">Todas</option>{s.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </div>
      <div className="tabs" role="group" aria-label="Filtros rápidos">
        {filters.map((f) => <button key={f} type="button" className="btn" aria-pressed={applied === f} onClick={() => setFilter(f)}>{STOCK_FILTERS[f]}</button>)}
        <span className="muted">{rows.length} resultado(s)</span>
      </div>
      {others.length > 0 && <p className="muted">El stock de otras sucursales es solo de consulta.</p>}
      <div className="table-wrap"><table>
        <thead><tr><th>Producto</th><th>Códigos</th><th className="num">Precio</th><th className="num">Stock aquí</th>{others.map((b) => <th key={b.id} className="num">{b.name}</th>)}</tr></thead>
        <tbody>{rows.slice(0, 300).map((i) => {
          const here = stockOf(s, branchId, i.variant.id);
          return (
            <tr key={i.variant.id} className={i.variant.active && i.product.active ? '' : 'dim'}>
              <td>{can('catalog.manage') ? <a href={`/app/producto?id=${i.product.id}`}>{i.label}</a> : i.label}<small>{s.categories.find((c) => c.id === i.product.categoryId)?.name}{!i.product.active || !i.variant.active ? ' · inactivo' : ''}</small></td>
              <td>{i.variant.sku}<small><a href={`/app/kardex?v=${i.variant.id}`}>{i.variant.barcode}</a></small></td>
              <td className="num">{money(i.variant.price)}</td>
              <td className={`num ${i.variant.minStock > 0 && here <= i.variant.minStock ? 'warn-text' : ''}`}><b>{here}</b></td>
              {others.map((b) => <td key={b.id} className="num muted">{stockOf(s, b.id, i.variant.id)}</td>)}
            </tr>
          );
        })}</tbody>
      </table>
        {!rows.length && <Empty>{items.length ? 'Ningún producto coincide con la búsqueda y el filtro.' : 'Aún no hay productos.'}</Empty>}
        {rows.length > 300 && <p className="muted">Mostrando 300 de {rows.length}. Afina la búsqueda.</p>}
      </div>
    </Page>
  );
}
