import { auditEntries } from '@/server/platform';
import { requireSuper } from '../session';

export default async function Audit() {
  const rows = await auditEntries(await requireSuper(), 300);
  return (
    <>
      <h1>Auditoría</h1>
      <p className="muted">Últimos 300 registros. No se pueden editar ni borrar desde la aplicación.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Entidad</th><th>Detalle</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id.toString()}><td>{r.createdAt.toLocaleString('es-PE', { timeZone: 'America/Lima' })}</td><td>{r.actorEmail}</td><td>{r.action}</td><td>{r.entity}<small>{r.entityId}</small></td>
            <td>{r.data ? <code>{JSON.stringify(r.data).slice(0, 300)}</code> : ''}</td></tr>
        ))}</tbody>
      </table></div>
    </>
  );
}
