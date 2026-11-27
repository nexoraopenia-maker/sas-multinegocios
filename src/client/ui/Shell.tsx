'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { Permission } from '@/shared/permissions';
import { ROLE_LABELS } from '@/shared/permissions';
import { StoreProvider, useStore } from '../store';

type NavItem = { href: string; label: string; icon: string; show?: Permission[]; feature?: 'multiBranch' | 'aiAgent' };
const NAV: NavItem[] = [
  { href: '/app', label: 'Inicio', icon: '🏠' },
  { href: '/app/pos', label: 'Vender', icon: '🛒', show: ['pos.sell'] },
  { href: '/app/ventas', label: 'Ventas', icon: '🧾', show: ['pos.sell'] },
  { href: '/app/caja', label: 'Caja', icon: '💵', show: ['cash.operate'] },
  { href: '/app/inventario', label: 'Inventario', icon: '📦', show: ['catalog.view'] },
  { href: '/app/ingreso', label: 'Ingreso', icon: '📥', show: ['stock.in'] },
  { href: '/app/ajustes', label: 'Ajustes y conteo', icon: '⚖️', show: ['stock.adjust.request', 'stock.adjust.approve'] },
  { href: '/app/traslados', label: 'Traslados', icon: '🚚', show: ['transfer.request', 'transfer.approve', 'transfer.operate'], feature: 'multiBranch' },
  { href: '/app/kardex', label: 'Kárdex', icon: '📒', show: ['catalog.view'] },
  { href: '/app/etiquetas', label: 'Etiquetas', icon: '🏷️', show: ['catalog.manage'] },
  { href: '/app/avisos', label: 'Avisos', icon: '🔔', show: ['notices.review'] },
  { href: '/app/reportes', label: 'Reportes', icon: '📊', show: ['reports.view'] },
  { href: '/app/agente', label: 'Asistente IA', icon: '🤖', show: ['agent.use'], feature: 'aiAgent' },
  { href: '/app/config', label: 'Configuración', icon: '⚙️', show: ['settings.manage'] },
];

function SyncBadge() {
  const { online, syncing, outbox, authNeeded } = useStore();
  const pending = outbox.filter((i) => i.status === 'PENDING').length;
  const rejected = outbox.filter((i) => i.status === 'REJECTED').length;
  const [state, text] = authNeeded ? ['error', 'Sesión vencida']
    : !online ? ['offline', pending ? `Sin conexión · ${pending} pendientes` : 'Sin conexión']
      : syncing ? ['syncing', 'Sincronizando…']
        : rejected ? ['error', `${rejected} rechazadas`]
          : pending ? ['pending', `${pending} pendientes`] : ['online', 'En línea'];
  return <a href="/app/sync" className={`status ${state}`} role="status"><i aria-hidden />{text}</a>;
}

function Frame({ children }: { children: ReactNode }) {
  const { user, branchId, setBranch, view, can, logout, authNeeded, syncError } = useStore();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => (!n.show || n.show.some(can)) && (!n.feature || user.features[n.feature]));
  const quick = items.slice(0, 4);
  const link = (n: NavItem) => (
    <a key={n.href} href={n.href} aria-current={path === n.href ? 'page' : undefined}>
      <span aria-hidden>{n.icon}</span>{n.label}
      {n.href === '/app/avisos' && !!view?.openNotices && <em className="count">{view.openNotices}</em>}
    </a>
  );
  return (
    <div className="shell">
      <aside className={`side no-print ${open ? 'open' : ''}`}>
        <div className="brand"><b>{user.tenantName}</b><small>{user.name} · {ROLE_LABELS[user.role]}</small></div>
        <nav>{items.map(link)}</nav>
        <button className="btn ghost" onClick={() => void logout()}>Cerrar sesión</button>
      </aside>
      {open && <button className="scrim no-print" aria-label="Cerrar menú" onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="top no-print">
          <button className="btn ghost menu" onClick={() => setOpen(true)} aria-label="Menú">☰</button>
          <select value={branchId} onChange={(e) => setBranch(e.target.value)} aria-label="Sucursal activa">
            {user.branchIds.map((id) => <option key={id} value={id}>{view?.branches.find((b) => b.id === id)?.name ?? 'Sucursal'}</option>)}
          </select>
          <SyncBadge />
        </header>
        {authNeeded && <p className="msg error no-print">Tu sesión venció. <a href="/login">Ingresa de nuevo</a> para sincronizar; tus operaciones pendientes se conservan.</p>}
        {syncError && !authNeeded && <p className="msg error no-print">{syncError}</p>}
        <main className="content">
          {view ? children : <p className="empty">Descargando datos de la sucursal… La primera vez se necesita conexión.</p>}
        </main>
      </div>
      <nav className="bottom no-print">{quick.map(link)}<button onClick={() => setOpen(true)}><span aria-hidden>☰</span>Más</button></nav>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
  }, []);
  return <StoreProvider><Frame>{children}</Frame></StoreProvider>;
}
