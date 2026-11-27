/** Envoltorio mínimo de IndexedDB: un almacén clave-valor y la cola de operaciones. */
import type { Operation } from '@/shared/operations';

export interface OutboxItem {
  id: string; seq: number; tenantId: string; userId: string; branchId: string; deviceKey: string; op: Operation;
  /** PENDING: por enviar · SENT: aplicada, falta refrescar datos · REJECTED: el servidor la rechazó */
  status: 'PENDING' | 'SENT' | 'REJECTED';
  error?: string;
}

let opening: Promise<IDBDatabase> | null = null;
function db() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('saas-pos', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('outbox', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error); };
  });
  return opening;
}

/** Ejecuta fn dentro de una transacción y resuelve cuando queda confirmada en disco. */
async function tx<T>(stores: ('kv' | 'outbox')[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => () => T): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const t = database.transaction(stores, mode);
    const result = fn(t);
    t.oncomplete = () => resolve(result());
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kvGet = <T>(key: string) => tx(['kv'], 'readonly', (t) => {
  const r = t.objectStore('kv').get(key);
  return () => r.result as T | undefined;
});
export const kvSet = (key: string, value: unknown) => tx(['kv'], 'readwrite', (t) => { t.objectStore('kv').put(value, key); return () => undefined; });
export const kvDeletePrefix = (prefix: string) => tx(['kv'], 'readwrite', (t) => {
  t.objectStore('kv').delete(IDBKeyRange.bound(prefix, `${prefix}￿`));
  return () => undefined;
});

/** Lectura y escritura atómicas (p. ej. el correlativo del comprobante, aun con varias pestañas). */
export const kvUpdate = <T>(key: string, change: (value: T | undefined) => T) => tx(['kv'], 'readwrite', (t) => {
  const store = t.objectStore('kv');
  const r = store.get(key);
  let next: T;
  r.onsuccess = () => { next = change(r.result as T | undefined); store.put(next, key); };
  return () => next;
});

export const outboxAll = () => tx(['outbox'], 'readonly', (t) => {
  const r = t.objectStore('outbox').getAll();
  return () => (r.result as OutboxItem[]).sort((a, b) => a.seq - b.seq);
});
export const outboxPut = (...items: OutboxItem[]) => tx(['outbox'], 'readwrite', (t) => {
  for (const i of items) t.objectStore('outbox').put(i);
  return () => undefined;
});
export const outboxDelete = (id: string) => tx(['outbox'], 'readwrite', (t) => { t.objectStore('outbox').delete(id); return () => undefined; });

/** Guarda los datos nuevos y retira las operaciones ya aplicadas en una sola transacción. */
export const saveSnapshot = (key: string, snapshot: unknown, appliedIds: string[]) => tx(['kv', 'outbox'], 'readwrite', (t) => {
  t.objectStore('kv').put(snapshot, key);
  for (const id of appliedIds) t.objectStore('outbox').delete(id);
  return () => undefined;
});
