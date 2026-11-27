export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}
export class OfflineError extends Error {
  constructor() { super('Sin conexión. Esta acción requiere internet.'); }
}

export async function api<T = unknown>(path: string, options: { body?: unknown; form?: FormData; timeout?: number } = {}): Promise<T> {
  const post = options.body !== undefined || options.form !== undefined;
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method: post ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      signal: AbortSignal.timeout(options.timeout ?? 45_000),
    });
  } catch {
    throw new OfflineError();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Error ${res.status}`, res.status, data.code ?? 'ERROR');
  return data as T;
}

export async function download(path: string, filename: string) {
  let res: Response;
  try { res = await fetch(`/api/${path}`, { credentials: 'same-origin' }); } catch { throw new OfflineError(); }
  if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).error ?? 'No se pudo descargar', res.status, 'ERROR');
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Ocurrió un error');
