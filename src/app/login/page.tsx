'use client';
import { useState } from 'react';
import { api } from '@/client/api';
import { Field, Notice, useAction } from '@/client/ui/kit';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, message, run } = useAction();
  return (
    <main className="center">
      <form className="card stack narrow" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        const r = await api<{ role: string; mustChangePassword: boolean }>('auth/login', { body: { email, password } });
        location.href = r.mustChangePassword ? '/cambiar-clave' : r.role === 'SUPERADMIN' ? '/super' : '/app';
      }); }}>
        <h1>Ingresar</h1>
        <p className="muted">Inventario y ventas</p>
        <Field label="Correo"><input type="email" required autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Contraseña"><input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Notice message={message} />
        <button className="btn primary big" disabled={busy}>{busy ? 'Ingresando…' : 'Ingresar'}</button>
      </form>
    </main>
  );
}
