import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticate, SESSION_COOKIE, type AuthInfo } from '../auth';
import type { Ctx } from '../context';
import { AppError, isUniqueViolation } from '../errors';

export interface RouteArgs { req: NextRequest; params: Record<string, string>; auth: AuthInfo; ctx: Ctx; token: string; query: Record<string, string> }
export interface Route {
  method: 'GET' | 'POST';
  path: string;
  /** public: sin sesión. any: sesión válida aunque deba cambiar la contraseña. business (por defecto). */
  access?: 'public' | 'any' | 'business';
  handler: (args: RouteArgs) => Promise<unknown>;
}

export async function body<T extends z.ZodType>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  const text = await req.text();
  if (text.length > 4_000_000) throw new AppError('Solicitud demasiado grande', 413);
  let json: unknown;
  try {
    json = JSON.parse(text || '{}');
  } catch {
    throw new AppError('JSON no válido');
  }
  return schema.parse(json);
}

export const clientIp = (headers: Headers) => headers.get('x-forwarded-for')?.split(',')[0].trim() || headers.get('x-real-ip') || 'local';

/** Protección CSRF: las peticiones que modifican datos deben venir del mismo origen. */
function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const site = req.headers.get('sec-fetch-site');
  if ((origin && new URL(origin).host !== host) || (!origin && site && site !== 'same-origin' && site !== 'none')) {
    throw new AppError('Origen no permitido', 403, 'BAD_ORIGIN');
  }
}

function match(pattern: string, parts: string[]) {
  const expected = pattern.split('/');
  if (expected.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i++) {
    if (expected[i].startsWith(':')) params[expected[i].slice(1)] = decodeURIComponent(parts[i]);
    else if (expected[i] !== parts[i]) return null;
  }
  return params;
}

export function errorResponse(e: unknown) {
  if (e instanceof z.ZodError) {
    return NextResponse.json({ error: e.issues.map((i) => `${i.path.join('.') || 'dato'}: ${i.message}`).join('; '), code: 'VALIDATION' }, { status: 400 });
  }
  if (e instanceof AppError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (isUniqueViolation(e)) return NextResponse.json({ error: 'El registro ya existe', code: 'CONFLICT' }, { status: 409 });
  console.error(e);
  return NextResponse.json({ error: 'Error interno. Inténtalo de nuevo.', code: 'INTERNAL' }, { status: 500 });
}

export async function dispatch(routes: Route[], req: NextRequest, parts: string[]) {
  try {
    let route: Route | undefined;
    let params: Record<string, string> = {};
    for (const r of routes) {
      const m = r.method === req.method && match(r.path, parts);
      if (m) { route = r; params = m; break; }
    }
    if (!route) throw new AppError('Ruta no encontrada', 404, 'NOT_FOUND');
    if (req.method !== 'GET') assertSameOrigin(req);
    const token = req.cookies.get(SESSION_COOKIE)?.value ?? '';
    const access = route.access ?? 'business';
    let auth = null as AuthInfo | null;
    if (access !== 'public') {
      auth = await authenticate(token);
      if (access === 'business') {
        if (auth.mustChangePassword) throw new AppError('Debes cambiar tu contraseña', 403, 'PASSWORD_CHANGE_REQUIRED');
        if (!auth.ctx) throw new AppError('Esta sección es para usuarios de un negocio', 403, 'FORBIDDEN');
      }
    }
    const result = await route.handler({ req, params, token, auth: auth!, ctx: auth?.ctx as Ctx, query: Object.fromEntries(req.nextUrl.searchParams) });
    const res = result instanceof Response ? result : NextResponse.json(result ?? { ok: true });
    if (!res.headers.has('Cache-Control')) res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
