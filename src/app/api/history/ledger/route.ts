import { badRequest, ok, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { resolveContext } from '@/lib/server/scope';
import { getSettings, loadLedgerInput } from '@/lib/server/projection-data';
import { buildLedger } from '@/lib/projection/ledger';
import { addDays, isISODate, todayInTz } from '@/lib/dates';

export const dynamic = 'force-dynamic';

/** Libro real (cobros/pagos ya registrados) para las columnas pasadas de la Matriz: ?ctx=…&from=YYYY-MM-DD (máx. 2 años). */
export const GET = route(async (req) => {
  const user = await requireUser();
  const sp = new URL(req.url).searchParams;
  const ctx = await resolveContext(user, sp.get('ctx'));
  const from = sp.get('from');
  if (!isISODate(from)) throw badRequest('Parámetro from inválido (YYYY-MM-DD)');
  const today = todayInTz((await getSettings()).timezone);
  const min = addDays(today, -731);
  return ok(buildLedger(await loadLedgerInput(ctx, from < min ? min : from)));
});
