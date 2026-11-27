'use client';
import { useState } from 'react';
import { api, download } from '@/client/api';
import { useStore } from '@/client/store';
import { Empty, Field, Notice, Page, useAction, useLoad } from '@/client/ui/kit';
import { money } from '@/shared/money';
import { REPORTS, type Report, type ReportType } from '@/shared/reports';
import { addDays, todayISO } from '@/shared/stock';

export default function Reports() {
  const { view, user, lastSync } = useStore();
  const [type, setType] = useState<ReportType>('sales_period');
  const [branch, setBranch] = useState('');
  const [from, setFrom] = useState(addDays(todayISO(), -30));
  const [to, setTo] = useState(todayISO());
  const query = `from=${from}&to=${to}${branch ? `&branchId=${branch}` : ''}`;
  const { data, error } = useLoad(() => api<Report>(`reports/${type}?${query}`, { timeout: 60_000 }), [type, query, lastSync]);
  const { busy, message, run } = useAction();
  const cell = (v: string | number | undefined, kind?: string) => (kind === 'money' && typeof v === 'number' ? money(v) : v);
  const get = (format: 'xlsx' | 'pdf') => run(() => download(`reports/${type}?${query}&format=${format}`, `${type}-${from}-${to}.${format}`));
  const snapshotOnly = type === 'valuation';
  return (
    <Page title="Reportes" actions={<><button className="btn" disabled={busy} onClick={() => get('xlsx')}>Excel</button><button className="btn" disabled={busy} onClick={() => get('pdf')}>PDF</button></>}>
      <div className="card grid3">
        <Field label="Reporte"><select value={type} onChange={(e) => setType(e.target.value as ReportType)}>{Object.entries(REPORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Sucursal"><select value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">Todas las mías</option>{view!.branches.filter((b) => user.branchIds.includes(b.id)).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        {!snapshotOnly && <><Field label="Desde"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="Hasta"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></>}
      </div>
      <Notice message={message} />
      {error && <p className="msg info">{error}</p>}
      {data && (
        <div className="table-wrap"><table>
          <thead><tr>{data.columns.map((c) => <th key={c.key} className={c.kind && c.kind !== 'text' ? 'num' : ''}>{c.label}</th>)}</tr></thead>
          <tbody>{data.rows.slice(0, 1000).map((r, i) => <tr key={i}>{data.columns.map((c) => <td key={c.key} className={c.kind && c.kind !== 'text' ? 'num' : ''}>{cell(r[c.key], c.kind)}</td>)}</tr>)}</tbody>
          {data.totals && <tfoot><tr>{data.columns.map((c, i) => <td key={c.key} className={i ? 'num' : ''}>{i === 0 ? 'Total' : cell(data.totals![c.key], c.kind)}</td>)}</tr></tfoot>}
        </table>{!data.rows.length && <Empty>Sin datos para este reporte.</Empty>}{data.rows.length > 1000 && <p className="muted">Se muestran 1000 filas. Exporta para ver todo.</p>}</div>
      )}
    </Page>
  );
}
