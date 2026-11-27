'use client';
/** Indicadores del negocio (requieren conexión y permiso de reportes). */
import { useState } from 'react';
import { DASHBOARD_PERIODS, type Dashboard as Data, type DaySales } from '@/shared/dashboard';
import { money } from '@/shared/money';
import { api } from '../api';
import { useStore } from '../store';
import { Empty, useLoad, when } from './kit';

const MOVEMENTS: Record<string, string> = {
  PURCHASE: 'Compras', INITIAL: 'Stock inicial', SALE: 'Ventas', SALE_VOID: 'Anulaciones', RETURN: 'Devoluciones', ADJUSTMENT: 'Ajustes',
  COUNT: 'Conteos', WASTE: 'Mermas', TRANSFER_OUT: 'Traslados (salida)', TRANSFER_IN: 'Traslados (entrada)',
};
const day = (iso: string) => `${iso.slice(8)}/${iso.slice(5, 7)}`;

function SalesChart({ series }: { series: DaySales[] }) {
  const [active, setActive] = useState<DaySales | null>(null);
  const max = Math.max(...series.map((d) => d.net), 0);
  const best = series.find((d) => d.net === max);
  const describe = (d: DaySales) => `${day(d.date)}: ${money(d.net)} en ${d.count} venta(s)`;
  if (max <= 0) return <Empty>No hay ventas en el periodo.</Empty>;
  return (
    <div className="chart">
      <p className="chart-readout" aria-live="polite">{active ? describe(active) : `Mejor día · ${describe(best!)}`}</p>
      <div className="bars" onMouseLeave={() => setActive(null)}>
        {series.map((d) => (
          <button key={d.date} type="button" aria-label={describe(d)} title={describe(d)} onMouseEnter={() => setActive(d)} onFocus={() => setActive(d)} onClick={() => setActive(d)}>
            <i style={{ height: `${d.net > 0 ? Math.max(1.5, (d.net / max) * 100) : 0}%` }} />
          </button>
        ))}
      </div>
      <div className="chart-axis"><span>{day(series[0].date)}</span><span>{day(series[series.length - 1].date)}</span></div>
      <details>
        <summary>Ver como tabla</summary>
        <div className="table-wrap"><table><thead><tr><th>Fecha</th><th className="num">Ventas</th><th className="num">Neto</th></tr></thead>
          <tbody>{series.filter((d) => d.count).map((d) => <tr key={d.date}><td>{d.date}</td><td className="num">{d.count}</td><td className="num">{money(d.net)}</td></tr>)}</tbody></table></div>
      </details>
    </div>
  );
}

const Kpi = ({ label, value, detail }: { label: string; value: string; detail?: string }) =>
  <div className="kpi"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;

export function Dashboard({ allBranches }: { allBranches: boolean }) {
  const { branchId, lastSync, can } = useStore();
  const [days, setDays] = useState<number>(30);
  const scope = allBranches ? '' : `&branchId=${branchId}`;
  const { data, error } = useLoad(() => api<Data>(`dashboard?days=${days}${scope}`), [days, scope, lastSync]);
  const maxMovement = Math.max(1, ...(data?.movements.map((m) => m.in + m.out) ?? []));

  return (
    <section className="stack" aria-label="Indicadores">
      <div className="row between">
        <h2>Resumen del negocio</h2>
        <div className="tabs" role="group" aria-label="Periodo">{DASHBOARD_PERIODS.map((d) => <button key={d} type="button" className="btn" aria-pressed={days === d} onClick={() => setDays(d)}>{d} días</button>)}</div>
      </div>
      {error && <p className="msg info">{error} Las alertas de abajo siguen disponibles.</p>}
      {!data && !error && <p className="muted">Cargando indicadores…</p>}
      {data && (
        <>
          <div className="cards">
            <Kpi label="Ventas de hoy" value={money(data.today.net)} detail={`${data.today.count} venta(s)`} />
            <Kpi label={`Ventas · ${data.days} días`} value={money(data.period.net)} detail={`${data.period.count} venta(s) · promedio ${money(data.period.average)}`} />
            {data.margin && <Kpi label="Margen estimado" value={money(data.margin.amount)} detail={`${data.margin.percent}% sobre lo vendido`} />}
            {data.valuation && <Kpi label="Inventario al costo" value={money(data.valuation.cost)} detail={`A precio de venta ${money(data.valuation.sale)} · margen potencial ${money(data.valuation.potential)}`} />}
            <Kpi label={`Compras · ${data.days} días`} value={data.purchases.total === null ? String(data.purchases.count) : money(data.purchases.total)} detail={`${data.purchases.count} ingreso(s)`} />
          </div>
          {(data.margin || data.valuation) && <p className="muted">Margen y valorización son aproximados: usan el costo registrado de cada producto.</p>}
          <div className="card stack"><h3>Ventas netas por día</h3><SalesChart series={data.series} /></div>
          <div className="cards wide">
            <div className="card stack">
              <div className="row between"><h3>Ingresos recientes</h3>{can('stock.in') && <a className="btn" href="/app/ingreso">Nuevo ingreso</a>}</div>
              {data.purchases.recent.map((p) => (
                <div key={p.id} className="row between">
                  <span className="grow">{p.reason}<small>{when(p.occurredAt)} · {p.branch} · {p.lines} línea(s), {p.units} und.{p.scanId && <> · <a href={`/api/purchases/${p.scanId}/file`} download>respaldo</a></>}</small></span>
                  {p.total !== null && <b>{money(p.total)}</b>}
                </div>
              ))}
              {!data.purchases.recent.length && <Empty>Aún no hay compras registradas.</Empty>}
            </div>
            <div className="card stack">
              <div className="row between"><h3>Movimientos · {data.days} días</h3><a className="btn" href="/app/kardex">Kárdex</a></div>
              {data.movements.map((m) => (
                <div key={m.type}>
                  <div className="row between"><span>{MOVEMENTS[m.type] ?? m.type}</span><span className="num">{m.in > 0 && <>+{m.in} </>}{m.out > 0 && <>−{m.out}</>}</span></div>
                  <i className="meter" style={{ width: `${((m.in + m.out) / maxMovement) * 100}%` }} aria-hidden />
                </div>
              ))}
              {!data.movements.length && <Empty>Sin movimientos en el periodo.</Empty>}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
