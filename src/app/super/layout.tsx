import type { ReactNode } from 'react';
import { logoutAction } from './actions';
import { requireSuper } from './session';

export const dynamic = 'force-dynamic';

export default async function SuperLayout({ children }: { children: ReactNode }) {
  const auth = await requireSuper();
  return (
    <div className="super">
      <header className="top">
        <b>SuperAdmin</b>
        <nav className="row"><a href="/super">Cuentas</a><a href="/super/nueva">Nueva cuenta</a><a href="/super/modelos">Modelos de IA</a><a href="/super/auditoria">Auditoría</a><a href="/cambiar-clave">Contraseña</a></nav>
        <form action={logoutAction}><button className="btn ghost">Salir ({auth.email})</button></form>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}
