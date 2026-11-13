import { prisma } from '@/lib/server/db';
import { ok, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { resolveContext, resolveWhatIf } from '@/lib/server/scope';
import { loadProjectionInput } from '@/lib/server/projection-data';
import { entityDto } from '@/lib/server/dto';
import { project } from '@/lib/projection/engine';

export const dynamic = 'force-dynamic';

/**
 * Proyección de liquidez del contexto. Devuelve también el input del motor
 * para que el cliente recalcule al instante durante la edición en línea.
 */
export const GET = route(async (req) => {
  const user = await requireUser();
  const sp = new URL(req.url).searchParams;
  const ctx = await resolveContext(user, sp.get('ctx'));
  const whatIf = resolveWhatIf(sp.get('whatIf'));
  const input = await loadProjectionInput(ctx, whatIf);
  const entities = await prisma.entity.findMany({ where: { id: { in: ctx.entityIds } } });
  return ok({
    ctx: ctx.ctx,
    entities: entities.map(entityDto),
    input,
    result: project(input),
  });
});
