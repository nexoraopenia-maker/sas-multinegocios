'use client';
import { useState } from 'react';
import { api, download } from '@/client/api';
import { useStore } from '@/client/store';
import { Field, Notice, Page, useAction } from '@/client/ui/kit';

type Report = { ok: boolean; rows: number; newProducts: number; newVariants: number; stockLines: number; errors: { row: number; message: string }[] };

export default function Import() {
  const { branchId, view, sync } = useStore();
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const { busy, message, run } = useAction();
  const send = (dryRun: boolean) => run(async () => {
    const form = new FormData();
    form.set('file', file!); form.set('branchId', branchId); form.set('dryRun', String(dryRun));
    const r = await api<Report>('catalog/import', { form, timeout: 120_000 });
    setReport(dryRun || !r.ok ? r : null);
    if (!dryRun && r.ok) { setFile(null); await sync(); return `Importación completa: ${r.newProducts} productos, ${r.newVariants} variantes, ${r.stockLines} ingresos de stock.`; }
  });
  return (
    <Page title="Carga masiva" actions={<><a className="btn" href="/app/inventario">Volver</a><button className="btn" onClick={() => void run(() => download('catalog/import-template', 'plantilla-productos.xlsx'))}>⬇️ Plantilla Excel</button></>}>
      <div className="card stack narrow">
        <p>El stock se cargará en <b>{view!.branches.find((b) => b.id === branchId)?.name}</b>. Primero se valida; si hay errores no se guarda nada.</p>
        <Field label="Archivo .xlsx o .csv (máx. 4 MB)"><input type="file" accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); }} /></Field>
        <button className="btn primary" disabled={!file || busy} onClick={() => send(true)}>{busy ? 'Procesando…' : 'Validar archivo'}</button>
        <Notice message={message} />
      </div>
      {report && (
        <div className="card stack">
          <p>{report.rows} filas · {report.newProducts} productos nuevos · {report.newVariants} variantes · {report.stockLines} líneas con stock</p>
          {report.ok ? <><p className="msg ok">El archivo es válido.</p><button className="btn primary" disabled={busy} onClick={() => send(false)}>Importar ahora</button></> : (
            <div className="table-wrap"><table><thead><tr><th>Fila</th><th>Error</th></tr></thead><tbody>{report.errors.map((e, i) => <tr key={i}><td>{e.row}</td><td>{e.message}</td></tr>)}</tbody></table></div>
          )}
        </div>
      )}
    </Page>
  );
}
