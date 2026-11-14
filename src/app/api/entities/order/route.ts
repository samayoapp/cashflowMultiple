import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, ok, readJson, route } from '@/lib/server/api';
import { requireAdmin } from '@/lib/server/auth';
import { entityDto } from '@/lib/server/dto';
import { ENTITY_ORDER } from '@/lib/server/scope';
import { id } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const schema = z.object({ ids: z.array(id).min(1).max(500) });

/**
 * Guarda el orden visual de las entidades (solo afecta cómo se listan).
 * Recibe los ids en el orden deseado; la Base siempre se muestra primero.
 */
export const PUT = route(async (req) => {
  await requireAdmin();
  const { ids } = schema.parse(await readJson(req));
  if (new Set(ids).size !== ids.length) throw badRequest('Lista de unidades de negocio con duplicados');
  const found = await prisma.entity.count({ where: { id: { in: ids } } });
  if (found !== ids.length) throw badRequest('Alguna unidad de negocio no existe');

  await prisma.$transaction(ids.map((entityId, i) => prisma.entity.update({ where: { id: entityId }, data: { sortOrder: i + 1 } })));
  const rows = await prisma.entity.findMany({ orderBy: ENTITY_ORDER });
  return ok(rows.map(entityDto));
});
