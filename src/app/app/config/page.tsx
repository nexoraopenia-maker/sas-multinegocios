'use client';
import { useEffect, useState } from 'react';
import { api } from '@/client/api';
import { useStore } from '@/client/store';
import { Field, Modal, Notice, Page, useAction, useLoad } from '@/client/ui/kit';
import { GRANTABLE, ROLE_LABELS, type BusinessRole, type Permission } from '@/shared/permissions';
import type { SettingsDto } from '@/shared/snapshot';

type Branch = { id?: string; code: string; name: string; address: string; active: boolean };
type User = { id?: string; name: string; email: string; role: BusinessRole; branchIds: string[]; extraPermissions: string[]; active: boolean; password?: string; mustChangePassword?: boolean };
const GRANT_LABELS: Partial<Record<Permission, string>> = {
  'stock.in': 'Ingresar mercadería', 'stock.adjust.request': 'Solicitar ajustes y conteos', 'transfer.request': 'Solicitar traslados', 'transfer.operate': 'Enviar y recibir traslados', 'pos.discount': 'Descuentos sin límite',
};

export default function Config() {
  const { can, user } = useStore();
  const [tab, setTab] = useState('business');
  const [newBranch, setNewBranch] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('tab') !== 'branches') return;
    setTab('branches');
    setNewBranch(q.get('nueva') === '1');
    // Se limpia la dirección para que al recargar no se vuelva a abrir el formulario.
    history.replaceState(null, '', location.pathname);
  }, []);
  if (!can('settings.manage')) return <Page title="Configuración"><p className="empty">Solo el administrador puede ver esta sección.</p></Page>;
  const tabs = [['business', 'Negocio'], ['branches', 'Sucursales'], ['users', 'Usuarios'], ...(user.features.sunat ? [['sunat', 'SUNAT']] : [])];
  return (
    <Page title="Configuración" actions={<a className="btn" href="/cambiar-clave">Cambiar mi contraseña</a>}>
      <div className="tabs">{tabs.map(([k, v]) => <button key={k} className="btn" aria-pressed={tab === k} onClick={() => setTab(k)}>{v}</button>)}</div>
      {tab === 'business' && <Business />}
      {tab === 'branches' && <Branches openNew={newBranch} />}
      {tab === 'users' && <Users />}
      {tab === 'sunat' && <Sunat />}
    </Page>
  );
}

function Business() {
  const { data, error } = useLoad(() => api<SettingsDto>('settings'), []);
  if (error) return <p className="msg info">{error}</p>;
  return data ? <BusinessForm initial={data} /> : null;
}

function BusinessForm({ initial }: { initial: SettingsDto }) {
  const { user, sync } = useStore();
  const [f, setF] = useState(initial);
  const { busy, message, run } = useAction();
  const toggle = (key: 'alertExpiredEnabled' | 'alertExpiringEnabled' | 'alertLowStockEnabled', label: string, allowed: boolean) => (
    <label className="check"><input type="checkbox" disabled={!allowed} checked={allowed && f[key]} onChange={(e) => setF({ ...f, [key]: e.target.checked })} /> {label}{!allowed && ' (no habilitada por el proveedor)'}</label>
  );
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => {
      const { currency: _currency, ...body } = f; void _currency;
      await api('settings', { body }); await sync(); return 'Configuración guardada';
    }); }}>
      <div className="card grid3">
        <Field label="Razón social / nombre comercial"><input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} /></Field>
        <Field label="RUC (opcional)"><input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} /></Field>
        <Field label="Pie del comprobante"><input value={f.ticketFooter} onChange={(e) => setF({ ...f, ticketFooter: e.target.value })} /></Field>
        <Field label="Descuento máximo del vendedor (%)"><input type="number" min={0} max={100} step="0.5" value={f.maxSellerDiscountPct} onChange={(e) => setF({ ...f, maxSellerDiscountPct: Number(e.target.value) })} /></Field>
        <Field label="Avisar vencimiento con (días)"><input type="number" min={1} max={365} value={f.expiryDaysAhead} onChange={(e) => setF({ ...f, expiryDaysAhead: Number(e.target.value) })} /></Field>
      </div>
      <div className="card stack"><h2>Alertas del panel</h2>
        {toggle('alertExpiredEnabled', 'Productos vencidos', user.features.alertExpiry)}
        {toggle('alertExpiringEnabled', 'Productos por vencer', user.features.alertExpiry)}
        {toggle('alertLowStockEnabled', 'Bajo stock', user.features.alertLowStock)}
      </div>
      <div className="card grid3"><h2 className="full">Etiquetas por defecto</h2>
        <Field label="Código"><select value={f.labelFormat.symbol} onChange={(e) => setF({ ...f, labelFormat: { ...f.labelFormat, symbol: e.target.value as SettingsDto['labelFormat']['symbol'] } })}><option value="code128">Code 128</option><option value="ean13">EAN-13</option><option value="qrcode">QR</option></select></Field>
        {([['widthMm', 'Ancho (mm)'], ['heightMm', 'Alto (mm)'], ['columns', 'Columnas']] as const).map(([k, label]) => <Field key={k} label={label}><input type="number" value={f.labelFormat[k]} onChange={(e) => setF({ ...f, labelFormat: { ...f.labelFormat, [k]: Number(e.target.value) } })} /></Field>)}
      </div>
      <Notice message={message} />
      <button className="btn primary" disabled={busy}>Guardar</button>
    </form>
  );
}

const emptyBranch = (): Branch => ({ code: '', name: '', address: '', active: true });

function Branches({ openNew }: { openNew: boolean }) {
  const { user, sync } = useStore();
  const { data, error, reload } = useLoad(() => api<Branch[]>('branches'), []);
  const [edit, setEdit] = useState<Branch | null>(null);
  useEffect(() => { if (openNew) setEdit(emptyBranch()); }, [openNew]);
  const { busy, message, run } = useAction();
  const limit = user.features.multiBranch ? user.features.maxBranches : 1;
  return (
    <div className="stack">
      <div className="row between"><p className="muted">Sucursales activas permitidas: {limit}</p><button className="btn primary" onClick={() => setEdit(emptyBranch())}>+ Sucursal</button></div>
      {error && <p className="msg info">{error}</p>}
      {data?.map((b) => <div key={b.id} className="card row between"><span><b>{b.name}</b> <span className="tag">{b.code}</span>{!b.active && <span className="tag danger">Inactiva</span>}<small>{b.address}</small></span><button className="btn" onClick={() => setEdit(b)}>Editar</button></div>)}
      {edit && (
        <Modal title={edit.id ? 'Editar sucursal' : 'Nueva sucursal'} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('branches', { body: edit }); setEdit(null); reload(); await sync(); location.reload(); }); }}>
            <Field label="Código (aparece en los comprobantes)"><input required pattern="[A-Za-z0-9]{2,6}" readOnly={!!edit.id} value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Nombre"><input required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Dirección"><input value={edit.address} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /></Field>
            <label className="check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Activa</label>
            <Notice message={message} />
            <button className="btn primary" disabled={busy}>Guardar</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Users() {
  const { view } = useStore();
  const { data, error, reload } = useLoad(() => api<User[]>('users'), []);
  const [edit, setEdit] = useState<User | null>(null);
  const { busy, message, run } = useAction();
  const flip = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="stack">
      <button className="btn primary" onClick={() => setEdit({ name: '', email: '', role: 'SELLER', branchIds: [view!.branchId], extraPermissions: [], active: true, password: '' })}>+ Usuario</button>
      {error && <p className="msg info">{error}</p>}
      {data?.map((u) => <div key={u.id} className="card row between"><span><b>{u.name}</b> <span className="tag">{ROLE_LABELS[u.role]}</span>{!u.active && <span className="tag danger">Inactivo</span>}{u.mustChangePassword && <span className="tag warn">Debe cambiar contraseña</span>}<small>{u.email}</small></span><button className="btn" onClick={() => setEdit({ ...u, password: '' })}>Editar</button></div>)}
      {edit && (
        <Modal title={edit.id ? 'Editar usuario' : 'Nuevo usuario'} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => {
            const { mustChangePassword: _m, ...u } = edit; void _m;
            await api('users', { body: { ...u, password: u.password || undefined } }); setEdit(null); reload();
          }); }}>
            <Field label="Nombre"><input required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Correo"><input type="email" required value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="Rol"><select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value as BusinessRole })}>{(['ADMIN', 'SUPERVISOR', 'SELLER'] as const).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></Field>
            <Field label={edit.id ? 'Restablecer contraseña (opcional)' : 'Contraseña temporal'} hint="Mínimo 10 caracteres con letras y números. Se pedirá cambiarla."><input type="text" autoComplete="off" required={!edit.id} value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
            {edit.role !== 'ADMIN' && <fieldset><legend>Sucursales</legend>{view!.branches.map((b) => <label key={b.id} className="check"><input type="checkbox" checked={edit.branchIds.includes(b.id)} onChange={() => setEdit({ ...edit, branchIds: flip(edit.branchIds, b.id) })} /> {b.name}</label>)}</fieldset>}
            {edit.role === 'SELLER' && <fieldset><legend>Permisos adicionales</legend>{GRANTABLE.map((p) => <label key={p} className="check"><input type="checkbox" checked={edit.extraPermissions.includes(p)} onChange={() => setEdit({ ...edit, extraPermissions: flip(edit.extraPermissions, p) })} /> {GRANT_LABELS[p]}</label>)}</fieldset>}
            <label className="check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Activo</label>
            <Notice message={message} />
            <button className="btn primary" disabled={busy}>Guardar</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Sunat() {
  const { data, error, reload } = useLoad(() => api<{ configured: boolean; ruc: string; solUser: string; environment: string; queued: number }>('sunat'), []);
  const [f, setF] = useState({ ruc: '', solUser: '', solPassword: '', certificateBase64: '', certificatePassword: '', environment: 'BETA' });
  const { busy, message, run } = useAction();
  const readFile = async (file?: File) => {
    if (!file) return;
    const url = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsDataURL(file); });
    setF((old) => ({ ...old, certificateBase64: url.split(',')[1] ?? '' }));
  };
  return (
    <form className="card stack narrow" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('sunat', { body: f }); reload(); return 'Datos guardados de forma cifrada'; }); }}>
      <p className="msg info">La emisión electrónica todavía no está disponible. Puedes dejar configurado el certificado; las ventas quedan en cola.</p>
      {error && <p className="msg info">{error}</p>}
      {data?.configured && <p>Configurado: RUC {data.ruc} · {data.environment} · {data.queued} comprobantes en cola</p>}
      <Field label="RUC"><input required pattern="\d{11}" value={f.ruc} onChange={(e) => setF({ ...f, ruc: e.target.value })} /></Field>
      <Field label="Usuario SOL"><input required value={f.solUser} onChange={(e) => setF({ ...f, solUser: e.target.value })} /></Field>
      <Field label="Clave SOL"><input type="password" required autoComplete="off" value={f.solPassword} onChange={(e) => setF({ ...f, solPassword: e.target.value })} /></Field>
      <Field label="Certificado digital (.pfx / .p12)"><input type="file" accept=".pfx,.p12" required onChange={(e) => void readFile(e.target.files?.[0])} /></Field>
      <Field label="Contraseña del certificado"><input type="password" autoComplete="off" value={f.certificatePassword} onChange={(e) => setF({ ...f, certificatePassword: e.target.value })} /></Field>
      <Field label="Entorno"><select value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })}><option value="BETA">Pruebas (beta)</option><option value="PRODUCCION">Producción</option></select></Field>
      <Notice message={message} />
      <button className="btn primary" disabled={busy}>Guardar</button>
    </form>
  );
}
