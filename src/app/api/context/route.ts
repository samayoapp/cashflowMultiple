import { prisma } from '@/lib/server/db';
import { ok, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { getAllowedEntityIds, resolveContext, resolveWhatIf } from '@/lib/server/scope';
import { entityDto } from '@/lib/server/dto';
import { getSettings } from '@/lib/server/projection-data';
import { todayInTz } from '@/lib/dates';
import { getCurrentFx } from '@/lib/server/fx';

export const dynamic = 'force-dynamic';

/** Datos globales de la barra superior: usuario, entidades, contexto, What-If y bandeja. */
export const GET = route(async (req) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const ctx = await resolveContext(user, url.searchParams.get('ctx'));
  const allIds = await getAllowedEntityIds(user, { includeArchived: true });
  const activeIds = await getAllowedEntityIds(user);
  const [entities, settings, pendingStaging, fx] = await Promise.all([
    prisma.entity.findMany({ where: { id: { in: allIds } }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }),
    getSettings(),
    prisma.stagingItem.count({ where: { entityId: { in: activeIds }, status: 'PENDING' } }),
    getCurrentFx(),
  ]);
  return ok({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    entities: entities.map(entityDto),
    ctx: ctx.ctx,
    whatIf: resolveWhatIf(url.searchParams.get('whatIf')),
    settings: { reportingCurrency: settings.reportingCurrency, timezone: settings.timezone },
    today: todayInTz(settings.timezone),
    pendingStaging,
    fx,
  });
});
