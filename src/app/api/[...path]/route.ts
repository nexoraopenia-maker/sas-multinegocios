import type { NextRequest } from 'next/server';
import { dispatch } from '@/server/api/http';
import { routes } from '@/server/api/routes';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Context = { params: Promise<{ path: string[] }> };
const handle = async (req: NextRequest, context: Context) => dispatch(routes, req, (await context.params).path);

export { handle as GET, handle as POST };
