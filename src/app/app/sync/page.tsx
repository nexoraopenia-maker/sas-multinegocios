'use client';
import { useStore } from '@/client/store';
import { Empty, Page, when } from '@/client/ui/kit';
import { OPERATION_LABELS } from '@/shared/operations';

export default function SyncStatus() {
  const { outbox, online, syncing, sync, lastSync, device, discard, syncError } = useStore();
  const rows = outbox.filter((i) => i.status !== 'SENT');
  return (
    <Page title="Sincronización" actions={<button className="btn primary" disabled={syncing} onClick={() => void sync()}>{syncing ? 'Sincronizando…' : 'Sincronizar ahora'}</button>}>
      <div className="card">
        <p><b>{online ? 'En línea' : 'Sin conexión'}</b> · Datos actualizados: {lastSync ? when(lastSync) : 'nunca'} · Serie del dispositivo: {device?.series ?? 'sin asignar'}</p>
        {syncError && <p className="msg error">{syncError}</p>}
        <p className="muted">Las operaciones se guardan primero en este dispositivo. No borres los datos del navegador mientras haya pendientes.</p>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Operación</th><th>Estado</th><th /></tr></thead>
        <tbody>{rows.map((i) => (
          <tr key={i.id}><td>{when(i.op.clientTime)}</td><td>{OPERATION_LABELS[i.op.type]}</td>
            <td>{i.status === 'PENDING' ? <span className="tag warn">Pendiente</span> : <><span className="tag danger">Rechazada</span><small>{i.error}</small></>}</td>
            <td>{i.status === 'REJECTED' && <button className="btn" onClick={() => { if (confirm('El supervisor ya fue avisado. ¿Quitar de la lista?')) void discard(i.id); }}>Quitar</button>}</td></tr>
        ))}</tbody>
      </table>{!rows.length && <Empty>Todo está sincronizado.</Empty>}</div>
    </Page>
  );
}
