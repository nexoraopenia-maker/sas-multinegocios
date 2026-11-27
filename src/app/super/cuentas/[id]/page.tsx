import { notFound } from 'next/navigation';
import { accountDetail } from '@/server/platform';
import { FEATURE_LABELS } from '@/shared/features';
import { ROLE_LABELS } from '@/shared/permissions';
import { ActionForm } from '../../ActionForm';
import { backupAction, deleteAction, featuresAction, passwordAction, resetAiAction, statusAction } from '../../actions';
import { requireSuper } from '../../session';
import { STATUS } from '../../status';

const when = (d: Date) => d.toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' });

export default async function Account({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireSuper();
  const detail = await accountDetail(actor, (await params).id).catch((e) => { if (e?.status === 404) notFound(); throw e; });
  const { account: a, users, backups, usage } = detail;
  const deleted = a.status === 'DELETED';
  const hidden = <input type="hidden" name="tenantId" value={a.id} />;
  return (
    <>
      <h1>{a.name} <span className={`tag ${STATUS[a.status][0]}`}>{STATUS[a.status][1]}</span></h1>
      <div className="cards wide">
        <section className="card stack">
          <h2>Funciones y límites</h2>
          <ActionForm action={featuresAction} submit="Guardar cambios">
            {hidden}
            {(['alertExpiry', 'alertLowStock', 'multiBranch', 'aiAgent', 'sunat'] as const).map((k) => <label key={k} className="check"><input type="checkbox" name={k} defaultChecked={a.features[k]} /> {FEATURE_LABELS[k]}{k === 'sunat' && ' (emisión aún no implementada)'}</label>)}
            <div className="grid2">
              <label className="field"><span>{FEATURE_LABELS.aiLimitType}</span><select name="aiLimitType" defaultValue={a.features.aiLimitType}><option value="USD">Dólares (US$)</option><option value="TOKENS">Tokens</option></select></label>
              <label className="field"><span>{FEATURE_LABELS.aiLimitValue}</span><input name="aiLimitValue" type="number" step="0.01" min="0" required defaultValue={a.features.aiLimitValue} /></label>
              <label className="field"><span>{FEATURE_LABELS.maxBranches}</span><input name="maxBranches" type="number" min="1" required defaultValue={a.features.maxBranches} /></label>
              <label className="field"><span>{FEATURE_LABELS.maxUsers}</span><input name="maxUsers" type="number" min="1" required defaultValue={a.features.maxUsers} /></label>
            </div>
          </ActionForm>
        </section>
        <section className="card stack">
          <h2>Consumo de IA</h2>
          <p>Acumulado desde el último reinicio: <b>US$ {a.aiUsd.toFixed(6)}</b> · <b>{a.aiTokens}</b> tokens</p>
          <ActionForm action={resetAiAction} submit="Reiniciar consumo" tone="" confirmText="¿Reiniciar el contador de consumo de IA?">{hidden}</ActionForm>
          <div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Modelo</th><th className="num">Tokens</th><th className="num">US$</th><th>Estado</th></tr></thead>
            <tbody>{usage.map((u) => <tr key={u.id}><td>{when(u.createdAt)}</td><td>{u.model}<small>{u.question}</small></td><td className="num">{u.inputTokens + u.outputTokens}</td><td className="num">{Number(u.costUsd).toFixed(6)}</td><td>{u.status}</td></tr>)}</tbody></table>
            {!usage.length && <p className="empty">Sin consultas.</p>}</div>
        </section>
        <section className="card stack">
          <h2>Usuarios</h2>
          {users.map((u) => (
            <details key={u.id}><summary>{u.name} · {u.email} <span className="tag">{ROLE_LABELS[u.role]}</span>{!u.active && <span className="tag danger">Inactivo</span>}</summary>
              <ActionForm action={passwordAction} submit="Restablecer contraseña" tone="">
                <input type="hidden" name="userId" value={u.id} />
                <label className="field"><span>Contraseña temporal</span><input name="password" type="text" autoComplete="off" required minLength={10} /></label>
              </ActionForm>
            </details>
          ))}
        </section>
        <section className="card stack">
          <h2>Estado y respaldos</h2>
          {!deleted && (
            <ActionForm action={statusAction} submit={a.status === 'ACTIVE' ? 'Suspender cuenta' : 'Reactivar cuenta'} tone={a.status === 'ACTIVE' ? 'danger' : 'primary'} confirmText={a.status === 'ACTIVE' ? '¿Suspender la cuenta? Se cerrarán sus sesiones.' : undefined}>
              {hidden}<input type="hidden" name="status" value={a.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'} />
            </ActionForm>
          )}
          <ActionForm action={backupAction} submit="Generar respaldo" tone="">{hidden}</ActionForm>
          <ul>{backups.map((b) => <li key={b.id}><a href={`/super/respaldos/${b.id}`} download>Respaldo del {when(b.createdAt)}</a></li>)}</ul>
          {!deleted && (
            <details><summary className="neg">Eliminar cuenta</summary>
              <p>Se genera un respaldo y la cuenta queda sin acceso. Los datos no se borran físicamente.</p>
              <ActionForm action={deleteAction} submit="Eliminar cuenta" tone="danger">
                {hidden}<label className="field"><span>Escribe <b>{a.name}</b> para confirmar</span><input name="confirmation" required autoComplete="off" /></label>
              </ActionForm>
            </details>
          )}
        </section>
      </div>
    </>
  );
}
