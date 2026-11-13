import { ok, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { resolveContext } from '@/lib/server/scope';
import { getCardsSummary } from '@/lib/server/cards';
import { getSettings } from '@/lib/server/projection-data';
import { todayInTz } from '@/lib/dates';

export const dynamic = 'force-dynamic';

/** Tarjetas del contexto con deuda, ciclo actual, próximo pago y estados de cuenta. */
export const GET = route(async (req) => {
  const user = await requireUser();
  const ctx = await resolveContext(user, new URL(req.url).searchParams.get('ctx'));
  const settings = await getSettings();
  return ok(await getCardsSummary(ctx.entityIds, todayInTz(settings.timezone)));
});
