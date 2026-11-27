'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/client/store';
import { buildItems } from '@/client/ui/products';
import { Empty, Page } from '@/client/ui/kit';
import { computeAlerts } from '@/shared/alerts';
import { alertSwitches } from '@/shared/snapshot';

type Tab = 'expired' | 'expiring' | 'lowStock';

export default function Home() {
  const { view, user, branchId, can } = useStore();
  const [all, setAll] = useState(false);
  const [tab, setTab] = useState<Tab | null>(null);
  const s = view!;
  const switches = alertSwitches(user.features, s.settings);

  // Las alertas se calculan en el dispositivo, también sin conexión.
  const alerts = useMemo(() => computeAlerts({
    variants: buildItems(s).map((i) => ({ id: i.variant.id, label: i.label, sku: i.variant.sku, minStock: i.variant.minStock, tracksExpiry: i.product.tracksExpiry, active: i.variant.active && i.product.active })),
    balances: s.balances, lots: s.lots, branchIds: all ? user.branchIds : [branchId], switches,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [s, all, branchId, user.branchIds, switches.expired, switches.expiring, switches.lowStock, switches.daysAhead]);

  const cards: { key: Tab; title: string; tone: string; enabled: boolean }[] = [
    { key: 'expired', title: 'Productos vencidos', tone: 'danger', enabled: switches.expired },
    { key: 'expiring', title: `Por vencer (${switches.daysAhead} días)`, tone: 'warn', enabled: switches.expiring },
    { key: 'lowStock', title: 'Bajo stock', tone: 'info', enabled: switches.lowStock },
  ];
  const visible = can('alerts.view') ? cards.filter((c) => c.enabled) : [];
  const branch = (id: string) => s.branches.find((b) => b.id === id)?.name ?? '';

  return (
    <Page title="Inicio" actions={user.branchIds.length > 1 && (
      <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Todas mis sucursales</label>
    )}>
      <div className="row">
        {can('pos.sell') && <a className="btn primary big" href="/app/pos">🛒 Nueva venta</a>}
        {can('stock.in') && <a className="btn big" href="/app/ingreso">📥 Ingresar mercadería</a>}
        {!!s.openNotices && <a className="btn big" href="/app/avisos">🔔 {s.openNotices} avisos para revisar</a>}
      </div>
      <div className="cards">
        {visible.map((c) => (
          <button key={c.key} className={`stat ${alerts[c.key].length ? c.tone : ''}`} aria-pressed={tab === c.key} onClick={() => setTab(tab === c.key ? null : c.key)}>
            <strong>{alerts[c.key].length}</strong><span>{c.title}</span><small>Ver listado</small>
          </button>
        ))}
      </div>
      {!visible.length && <Empty>No hay alertas activadas para tu cuenta.</Empty>}
      {tab && (
        <div className="table-wrap">
          {tab === 'lowStock' ? (
            <table><thead><tr><th>Producto</th><th>Sucursal</th><th className="num">Stock</th><th className="num">Mínimo</th></tr></thead>
              <tbody>{alerts.lowStock.map((a) => <tr key={a.variantId + a.branchId}><td><a href={`/app/kardex?v=${a.variantId}`}>{a.label}</a><small>{a.sku}</small></td><td>{branch(a.branchId)}</td><td className="num">{a.quantity}</td><td className="num">{a.minStock}</td></tr>)}</tbody>
            </table>
          ) : (
            <table><thead><tr><th>Producto</th><th>Lote</th><th>Vence</th><th>Sucursal</th><th className="num">Cantidad</th></tr></thead>
              <tbody>{alerts[tab].map((a) => <tr key={a.branchId + a.variantId + a.lotCode}><td><a href={`/app/kardex?v=${a.variantId}`}>{a.label}</a><small>{a.sku}</small></td><td>{a.lotCode}</td><td>{a.expiresAt}</td><td>{branch(a.branchId)}</td><td className="num">{a.quantity}</td></tr>)}</tbody>
            </table>
          )}
          {!alerts[tab].length && <Empty>Sin productos en esta alerta.</Empty>}
        </div>
      )}
    </Page>
  );
}
