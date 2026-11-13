import { ok, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { getCurrentFx } from '@/lib/server/fx';

export const dynamic = 'force-dynamic';

/** Tasa USD→HNL vigente: oficial, spread bancario y venta efectiva. */
export const GET = route(async () => {
  await requireUser();
  return ok(await getCurrentFx());
});
