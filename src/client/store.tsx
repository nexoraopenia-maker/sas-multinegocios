'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Operation, OperationType, Payload } from '@/shared/operations';
import type { Permission } from '@/shared/permissions';
import type { DeviceDto, SessionUser, Snapshot } from '@/shared/snapshot';
import { api, ApiError, errorText, OfflineError } from './api';
import { kvDeletePrefix, kvGet, kvSet, kvUpdate, outboxAll, outboxDelete, outboxPut, saveSnapshot, type OutboxItem } from './idb';
import { applyPending } from './local';

export interface OpOutcome { id: string; state: 'applied' | 'queued'; result?: Record<string, unknown> }

interface Store {
  user: SessionUser; branchId: string; setBranch: (id: string) => void; view: Snapshot | null; device: DeviceDto | null;
  outbox: OutboxItem[]; online: boolean; syncing: boolean; syncError: string; lastSync: string | null; authNeeded: boolean;
  can: (p: Permission) => boolean;
  /** Guarda la operación en el dispositivo y la envía si hay red. Lanza error si el servidor la rechaza en el momento. */
  submit: <T extends OperationType>(type: T, payload: Payload<T>) => Promise<OpOutcome>;
  /** Acciones que requieren conexión (aprobaciones, anulaciones, devoluciones). */
  submitOnline: <T extends OperationType>(type: T, payload: Payload<T>) => Promise<OpOutcome>;
  nextNumber: () => Promise<number>;
  sync: () => Promise<void>;
  discard: (id: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<Store | null>(null);
export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error('Fuera de StoreProvider');
  return s;
};

const deviceName = () => {
  const ua = navigator.userAgent;
  return `${/iPad|Tablet/.test(ua) ? 'Tablet' : /Mobi/.test(ua) ? 'Celular' : 'Computadora'}`;
};

export function StoreProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [branchId, setBranchId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [device, setDevice] = useState<DeviceDto | null>(null);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [authNeeded, setAuthNeeded] = useState(false);
  const [blocked, setBlocked] = useState('');
  const deviceKey = useRef('');
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const lastSeq = useRef(0);

  const keys = useCallback((u: SessionUser, b: string) => ({ snapshot: `snapshot:${u.tenantId}:${u.id}:${b}`, device: `device:${u.tenantId}:${b}` }), []);
  const mine = useCallback(async (u: SessionUser) => (await outboxAll()).filter((i) => i.tenantId === u.tenantId && i.userId === u.id), []);
  const reloadOutbox = useCallback(async (u: SessionUser) => setOutbox(await mine(u)), [mine]);

  const handleAuthError = useCallback(async (e: unknown) => {
    if (!(e instanceof ApiError)) return;
    if (e.status === 401) setAuthNeeded(true);
    if (e.code === 'PASSWORD_CHANGE_REQUIRED') location.href = '/cambiar-clave';
    if (e.code === 'ACCOUNT_SUSPENDED') {
      // Se borran los datos locales del negocio; las operaciones pendientes se conservan por si se reactiva.
      await kvDeletePrefix('snapshot:');
      await kvDeletePrefix('user');
      setBlocked(e.message);
    }
  }, []);

  // ── Arranque: sesión del servidor o, sin red, la guardada y vigente ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      deviceKey.current = await kvUpdate<string>('deviceKey', (k) => k ?? crypto.randomUUID());
      let current: SessionUser | null = null;
      try {
        const me = await api<{ user: SessionUser | null; mustChangePassword?: boolean; role?: string }>('auth/me', { timeout: 6000 });
        if (me.mustChangePassword || me.user?.mustChangePassword) { location.href = '/cambiar-clave'; return; }
        if (!me.user) { location.href = '/super'; return; }
        current = me.user;
        await kvSet('user', current);
      } catch (e) {
        if (e instanceof OfflineError || (e instanceof ApiError && e.status >= 500)) {
          const cached = await kvGet<SessionUser>('user');
          if (cached && new Date(cached.sessionExpiresAt) > new Date()) { current = cached; setOnline(false); }
          else { setBlocked('Sin conexión y sin una sesión vigente en este dispositivo. Conéctate para ingresar.'); return; }
        } else if (e instanceof ApiError && e.status === 401) { location.href = '/login'; return; }
        else { await handleAuthError(e); setBlocked((b) => b || errorText(e)); return; }
      }
      if (cancelled || !current) return;
      const saved = await kvGet<string>(`branch:${current.id}`);
      const branch = saved && current.branchIds.includes(saved) ? saved : current.branchIds[0];
      if (!branch) { setBlocked('Tu usuario no tiene una sucursal asignada. Pide al administrador que te asigne una.'); return; }
      setUser(current);
      setBranchId(branch);
    })().catch((e) => setBlocked(`No se pudo iniciar la aplicación: ${errorText(e)}`));
    return () => { cancelled = true; };
  }, [handleAuthError]);

  useEffect(() => {
    if (!user || !branchId) return;
    let cancelled = false;
    (async () => {
      const k = keys(user, branchId);
      const [cached, dev] = await Promise.all([kvGet<Snapshot>(k.snapshot), kvGet<DeviceDto>(k.device)]);
      if (cancelled) return;
      setSnapshot(cached ?? null);
      setDevice(dev ?? null);
      await reloadOutbox(user);
    })();
    return () => { cancelled = true; };
  }, [user, branchId, keys, reloadOutbox]);

  const syncOnce = useCallback(async () => {
    if (!user || !branchId) return;
    const k = keys(user, branchId);
    let dev = await kvGet<DeviceDto>(k.device);
    if (!dev) {
      dev = await api<DeviceDto>('sync/device', { body: { deviceKey: deviceKey.current, branchId, name: deviceName() } });
      const fresh = dev;
      dev = await kvUpdate<DeviceDto>(k.device, (old) => old ?? fresh);
    }
    setDevice(dev);
    // 1) Enviar en orden lo pendiente.
    for (;;) {
      const pending = (await mine(user)).filter((i) => i.status === 'PENDING');
      if (!pending.length) break;
      const batch = pending.filter((i) => i.deviceKey === pending[0].deviceKey).slice(0, 20);
      const { results, interrupted } = await api<{ results: { id: string; status: string; error?: string; result?: Record<string, unknown> }[]; interrupted: boolean }>(
        'sync/push', { body: { deviceKey: batch[0].deviceKey, pending: pending.length, operations: batch.map((i) => i.op) } });
      for (const r of results) {
        const item = batch.find((i) => i.id === r.id)!;
        await outboxPut({ ...item, status: r.status === 'APPLIED' ? 'SENT' : 'REJECTED', error: r.error });
        if (r.result) await kvSet(`result:${r.id}`, r.result);
      }
      await reloadOutbox(user);
      if (interrupted || !results.length) throw new Error('El servidor no pudo completar la sincronización. Se reintentará.');
    }
    // 2) Traer datos frescos y retirar lo ya aplicado.
    const fresh = await api<Snapshot>(`sync/pull?branchId=${encodeURIComponent(branchId)}&deviceKey=${deviceKey.current}`);
    const applied = (await mine(user)).filter((i) => i.status === 'SENT').map((i) => i.id);
    await saveSnapshot(k.snapshot, fresh, applied);
    setSnapshot(fresh);
    await reloadOutbox(user);
    // Refresca permisos y funciones habilitadas por el SuperAdmin.
    const me = await api<{ user: SessionUser | null }>('auth/me');
    if (me.user) {
      await kvSet('user', me.user);
      if (JSON.stringify({ ...me.user, sessionExpiresAt: '' }) !== JSON.stringify({ ...user, sessionExpiresAt: '' })) setUser(me.user);
    }
  }, [user, branchId, keys, mine, reloadOutbox]);

  const sync = useCallback((): Promise<void> => {
    if (running.current) { again.current = true; return running.current; }
    const job = async () => {
      setSyncing(true);
      try {
        do {
          again.current = false;
          // Un solo envío a la vez entre pestañas; la idempotencia cubre el resto.
          await (navigator.locks ? navigator.locks.request('saas-sync', syncOnce) : syncOnce());
        } while (again.current);
        setOnline(true); setSyncError(''); setAuthNeeded(false);
      } catch (e) {
        if (e instanceof OfflineError) setOnline(false);
        else { setSyncError(errorText(e)); await handleAuthError(e); }
      } finally {
        setSyncing(false);
        running.current = null;
      }
    };
    running.current = job();
    return running.current;
  }, [syncOnce, handleAuthError]);

  useEffect(() => {
    if (!user || !branchId) return;
    void sync();
    const on = () => void sync();
    const off = () => setOnline(false);
    const timer = setInterval(on, 30_000);
    const visible = () => { if (document.visibilityState === 'visible') on(); };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [user, branchId, sync]);

  const enqueue = useCallback(async <T extends OperationType>(type: T, payload: Payload<T>) => {
    if (!user) throw new Error('Sin sesión');
    const op: Operation = { id: crypto.randomUUID(), type, payload, clientTime: new Date().toISOString() };
    lastSeq.current = Math.max(Date.now() * 1000, lastSeq.current + 1); // orden estable de envío
    const item: OutboxItem = { id: op.id, seq: lastSeq.current, tenantId: user.tenantId, userId: user.id, branchId, deviceKey: deviceKey.current, op, status: 'PENDING' };
    await outboxPut(item);
    await reloadOutbox(user);
    return item;
  }, [user, branchId, reloadOutbox]);

  const submit = useCallback(async <T extends OperationType>(type: T, payload: Payload<T>): Promise<OpOutcome> => {
    const item = await enqueue(type, payload);
    if (!navigator.onLine) { setOnline(false); return { id: item.id, state: 'queued' }; }
    // Espera breve: si la red está lenta, la operación queda en cola y se sigue trabajando.
    await Promise.race([sync().then(() => (running.current ?? undefined)), new Promise((r) => setTimeout(r, 6000))]);
    const after = (await outboxAll()).find((i) => i.id === item.id);
    if (after?.status === 'REJECTED') {
      await outboxDelete(item.id);
      if (user) await reloadOutbox(user);
      throw new Error(after.error ?? 'Operación rechazada');
    }
    if (!after || after.status === 'SENT') return { id: item.id, state: 'applied', result: await kvGet(`result:${item.id}`) };
    return { id: item.id, state: 'queued' };
  }, [enqueue, sync, user, reloadOutbox]);

  const submitOnline = useCallback(async <T extends OperationType>(type: T, payload: Payload<T>): Promise<OpOutcome> => {
    if (!navigator.onLine) throw new OfflineError();
    await sync(); // primero lo pendiente, para respetar el orden
    const id = crypto.randomUUID();
    const { results } = await api<{ results: { status: string; error?: string; result?: Record<string, unknown> }[] }>(
      'sync/push', { body: { deviceKey: deviceKey.current, operations: [{ id, type, payload, clientTime: new Date().toISOString() }] } });
    if (!results[0]) throw new Error('El servidor no pudo completar la acción. Revisa antes de reintentar.');
    if (results[0].status !== 'APPLIED') throw new Error(results[0].error ?? 'Operación rechazada');
    await sync();
    return { id, state: 'applied', result: results[0].result };
  }, [sync]);

  const nextNumber = useCallback(async () => {
    if (!user) throw new Error('Sin sesión');
    const next = await kvUpdate<DeviceDto | undefined>(keys(user, branchId).device, (d) => d && { ...d, lastNumber: d.lastNumber + 1 });
    if (!next) throw new Error('Conéctate una vez para asignar la serie de comprobantes a este dispositivo.');
    setDevice(next);
    return next.lastNumber;
  }, [user, branchId, keys]);

  const logout = useCallback(async () => {
    const pending = outbox.filter((i) => i.status === 'PENDING').length;
    if (pending && !confirm(`Hay ${pending} operaciones sin sincronizar. Se enviarán cuando vuelvas a ingresar en este dispositivo. ¿Salir?`)) return;
    try { await api('auth/logout', { body: {} }); } catch (e) {
      if (e instanceof OfflineError) { alert('Para cerrar sesión necesitas conexión.'); return; }
    }
    await kvDeletePrefix('snapshot:');
    await kvDeletePrefix('user');
    await kvDeletePrefix('result:');
    location.href = '/login';
  }, [outbox]);

  const view = useMemo(() => (snapshot ? applyPending(snapshot, outbox) : null), [snapshot, outbox]);
  const value = useMemo<Store | null>(() => user && branchId ? {
    user, branchId, view, device, outbox, online, syncing, syncError, authNeeded, lastSync: snapshot?.takenAt ?? null,
    setBranch: (id) => { void kvSet(`branch:${user.id}`, id); setSnapshot(null); setDevice(null); setBranchId(id); },
    can: (p) => user.permissions.includes(p),
    submit, submitOnline, nextNumber, sync, logout,
    discard: async (id) => { await outboxDelete(id); await reloadOutbox(user); },
  } : null, [user, branchId, view, device, outbox, online, syncing, syncError, authNeeded, snapshot, submit, submitOnline, nextNumber, sync, logout, reloadOutbox]);

  if (blocked) {
    return (
      <main className="center"><div className="card narrow stack">
        <h1>No es posible continuar</h1><p>{blocked}</p>
        <button className="btn primary" onClick={() => location.reload()}>Reintentar</button>
        <a href="/login">Ir al inicio de sesión</a>
      </div></main>
    );
  }
  if (!value) return <main className="center"><p className="muted">Cargando…</p></main>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
