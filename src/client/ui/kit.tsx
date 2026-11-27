'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { errorText } from '../api';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); }, []);
  return (
    <dialog ref={ref} className="modal" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <header><h2>{title}</h2><button type="button" className="btn ghost" onClick={onClose} aria-label="Cerrar">✕</button></header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

export type Message = { kind: 'ok' | 'error' | 'info'; text: string } | null;
export const Notice = ({ message }: { message: Message }) =>
  message ? <p className={`msg ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p> : null;

/** Ejecuta una acción con estado de espera y mensaje; evita el doble envío. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const lock = useRef(false);
  const run = useCallback(async (fn: () => Promise<string | void>) => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ kind: 'ok', text });
      return true;
    } catch (e) {
      setMessage({ kind: 'error', text: errorText(e) });
      return false;
    } finally { lock.current = false; setBusy(false); }
  }, []);
  return { busy, message, setMessage, run };
}

/** Carga datos del servidor (pantallas que requieren conexión). */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stale = false;
    setError('');
    load().then((d) => { if (!stale) setData(d); }).catch((e) => { if (!stale) { setData(null); setError(errorText(e)); } });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export function useQueryParam(name: string) {
  const [value, setValue] = useState<string | null | undefined>(undefined);
  useEffect(() => { setValue(new URLSearchParams(location.search).get(name)); }, [name]);
  return value;
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="page-head no-print"><h1>{title}</h1><div className="row">{actions}</div></div>
      {children}
    </>
  );
}

export const when = (iso: string) => new Date(iso).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
