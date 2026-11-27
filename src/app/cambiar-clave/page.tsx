'use client';
import { useState } from 'react';
import { api } from '@/client/api';
import { Field, Notice, useAction } from '@/client/ui/kit';

export default function ChangePassword() {
  const [form, setForm] = useState({ current: '', next: '', repeat: '' });
  const { busy, message, run } = useAction();
  const input = (k: keyof typeof form, label: string, auto: string) => (
    <Field label={label}><input type="password" required autoComplete={auto} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></Field>
  );
  return (
    <main className="center">
      <form className="card stack narrow" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        if (form.next !== form.repeat) throw new Error('Las contraseñas nuevas no coinciden');
        const r = await api<{ role: string }>('auth/change-password', { body: { current: form.current, next: form.next } });
        location.href = r.role === 'SUPERADMIN' ? '/super' : '/app';
      }); }}>
        <h1>Cambia tu contraseña</h1>
        <p className="muted">Mínimo 10 caracteres, con letras y números.</p>
        {input('current', 'Contraseña actual', 'current-password')}
        {input('next', 'Nueva contraseña', 'new-password')}
        {input('repeat', 'Repite la nueva contraseña', 'new-password')}
        <Notice message={message} />
        <button className="btn primary big" disabled={busy}>Guardar</button>
        <a href="/login">Volver al inicio de sesión</a>
      </form>
    </main>
  );
}
