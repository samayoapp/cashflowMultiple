import { prisma } from '@/lib/server/db';
import { conflict, notFound, ok, route } from '@/lib/server/api';
import { requireAdmin } from '@/lib/server/auth';
import { entityDto } from '@/lib/server/dto';

export const dynamic = 'force-dynamic';

/**
 * Marca la entidad como Base (principal): aparece primero en el menú y es la entidad
 * por defecto en los formularios. Solo puede haber una (índice parcial Entity_single_default).
 */
export const POST = route<{ params: { id: string } }>(async (_req, { params }) => {
  await requireAdmin();
  const entity = await prisma.entity.findUnique({ where: { id: params.id } });
  if (!entity) throw notFound('Unidad de negocio no encontrada');
  if (entity.archivedAt) throw conflict('Reactiva la unidad de negocio antes de definirla como Base');
  if (entity.isDefault) return ok(entityDto(entity));

  const updated = await prisma.$transaction(async (tx) => {
    await tx.entity.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    return tx.entity.update({ where: { id: entity.id }, data: { isDefault: true } });
  });
  return ok(entityDto(updated));
});
