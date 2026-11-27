'use client';
import { startTransition, useActionState, type ReactNode } from 'react';
import type { ActionState } from './actions';

export function ActionForm({ action, children, confirmText, className = 'stack', submit, tone = 'primary' }: {
  action: (s: ActionState, f: FormData) => Promise<ActionState>; children?: ReactNode; confirmText?: string; className?: string; submit: string; tone?: string;
}) {
  const [state, run, pending] = useActionState(action, {});
  return (
    // onSubmit + action manual evita que React vacíe el formulario cuando hay un error.
    <form className={className} onSubmit={(e) => {
      e.preventDefault();
      if (confirmText && !confirm(confirmText)) return;
      const data = new FormData(e.currentTarget);
      startTransition(() => run(data));
    }}>
      {children}
      <button className={`btn ${tone}`} disabled={pending}>{pending ? 'Procesando…' : submit}</button>
      {state.ok && <p className="msg ok" role="status">{state.ok}</p>}
      {state.error && <p className="msg error" role="alert">{state.error}</p>}
    </form>
  );
}
