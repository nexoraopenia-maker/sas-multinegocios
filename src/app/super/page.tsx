import { listAccounts } from '@/server/platform';
import { BUSINESS_TYPES, type BusinessType } from '@/shared/attributes';
import { requireSuper } from './session';
import { STATUS } from './status';

const ago = (ms: number) => (ms ? new Date(ms).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : 'Nunca');

export default async function Dashboard() {
  const accounts = await listAccounts(await requireSuper());
  const live = accounts.filter((a) => a.status !== 'DELETED');
  const sum = (fn: (a: (typeof accounts)[number]) => number) => accounts.reduce((s, a) => s + fn(a), 0);
  const stats = [
    ['Cuentas activas', accounts.filter((a) => a.status === 'ACTIVE').length],
    ['Suspendidas', accounts.filter((a) => a.status === 'SUSPENDED').length],
    ['Usuarios activos', live.reduce((s, a) => s + a.users, 0)],
    ['Ventas (30 días)', sum((a) => a.sales30)],
    ['Consumo de IA (US$)', sum((a) => a.aiUsd).toFixed(4)],
    ['Dispositivos', sum((a) => a.devices)],
    ['Pendientes de sincronizar', sum((a) => a.pending)],
    ['Operaciones rechazadas (30 días)', sum((a) => a.rejected30)],
  ];
  return (
    <>
      <h1>Cuentas</h1>
      <div className="cards">{stats.map(([label, value]) => <div key={label} className="stat static"><strong>{value}</strong><span>{label}</span></div>)}</div>
      <div className="table-wrap"><table>
        <thead><tr><th>Negocio</th><th>Estado</th><th className="num">Usuarios</th><th className="num">Ventas 30d</th><th>Consumo IA / límite</th><th>Última sincronización</th><th className="num">Pendientes</th></tr></thead>
        <tbody>{accounts.map((a) => (
          <tr key={a.id}>
            <td><a href={`/super/cuentas/${a.id}`}>{a.name}</a><small>{a.adminEmail} · {BUSINESS_TYPES[a.businessType as BusinessType]}</small></td>
            <td><span className={`tag ${STATUS[a.status][0]}`}>{STATUS[a.status][1]}</span></td>
            <td className="num">{a.users}</td><td className="num">{a.sales30}</td>
            <td>{a.features.aiAgent ? (a.features.aiLimitType === 'USD' ? `US$ ${a.aiUsd.toFixed(4)} / ${a.features.aiLimitValue}` : `${a.aiTokens} / ${a.features.aiLimitValue} tokens`) : 'Desactivado'}</td>
            <td>{ago(a.lastSync)}</td><td className="num">{a.pending}</td>
          </tr>
        ))}</tbody>
      </table>{!accounts.length && <p className="empty">Aún no hay cuentas. <a href="/super/nueva">Crea la primera</a>.</p>}</div>
    </>
  );
}
