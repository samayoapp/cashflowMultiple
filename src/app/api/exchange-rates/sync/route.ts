import { z } from 'zod';
import { ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { syncToday } from '@/lib/server/fx';

export const dynamic = 'force-dynamic';

const schema = z.object({ force: z.boolean().optional() }).default({});

/** Fuerza la sincronización en línea. `force` (solo ADMIN) reemplaza una tasa manual del día. */
export const POST = route(async (req) => {
  const user = await requireUser();
  const raw = await readJson(req).catch(() => ({}));
  const data = schema.parse(raw ?? {});
  return ok(await syncToday({ force: Boolean(data.force) && user.role === 'ADMIN' }));
});
