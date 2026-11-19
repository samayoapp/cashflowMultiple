import { ok, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { resolveContext } from '@/lib/server/scope';
import { loadHistoryInput } from '@/lib/server/projection-data';
import { buildHistory } from '@/lib/projection/history';

export const dynamic = 'force-dynamic';

/** Historial real de caja: ?ctx=…&weeks=13 (4–52 semanas completas antes de la semana en curso). */
export const GET = route(async (req) => {
  const user = await requireUser();
  const sp = new URL(req.url).searchParams;
  const ctx = await resolveContext(user, sp.get('ctx'));
  const weeks = Math.min(Math.max(Number(sp.get('weeks')) || 13, 4), 52);
  return ok(buildHistory(await loadHistoryInput(ctx, weeks)));
});
