'use client';
import { api } from '@/client/api';
import { useStore } from '@/client/store';
import { Empty, Notice, Page, useAction, useLoad, when } from '@/client/ui/kit';

type Row = { id: string; branchId: string | null; type: string; message: string; createdAt: string };
const TYPES: Record<string, string> = { NEGATIVE_STOCK: 'Stock negativo', PRICE_REVIEW: 'Revisar venta', SYNC_REJECTED: 'Operación rechazada', TRANSFER_DIFFERENCE: 'Diferencia en traslado', CASH_REVIEW: 'Revisar caja', AI_LIMIT: 'Límite de IA' };

export default function Notices() {
  const { view, lastSync, sync } = useStore();
  const { data, error, reload } = useLoad(() => api<Row[]>('notices'), [lastSync]);
  const { busy, message, run } = useAction();
  return (
    <Page title="Avisos para el supervisor">
      <Notice message={message} />
      {error && <p className="msg info">{error}</p>}
      {data?.map((r) => (
        <div key={r.id} className="card row between">
          <span className="grow"><span className="tag warn">{TYPES[r.type] ?? r.type}</span> {r.message}<small>{when(r.createdAt)} {view!.branches.find((b) => b.id === r.branchId)?.name}</small></span>
          <button className="btn" disabled={busy} onClick={() => run(async () => { await api(`notices/${r.id}/resolve`, { body: {} }); reload(); void sync(); })}>Resuelto</button>
        </div>
      ))}
      {data && !data.length && <Empty>No hay avisos pendientes.</Empty>}
    </Page>
  );
}
