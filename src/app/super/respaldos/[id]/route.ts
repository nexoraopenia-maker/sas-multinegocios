import { getBackup } from '@/server/platform';
import { requireSuper } from '../../session';

export const runtime = 'nodejs';

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await requireSuper();
  const backup = await getBackup(actor, (await context.params).id);
  return new Response(new Uint8Array(backup.data), {
    headers: { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="respaldo-${backup.tenantId}-${backup.createdAt.toISOString().slice(0, 10)}.json.gz"`, 'Cache-Control': 'no-store' },
  });
}
