import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { assertCategoryNameFree, CATEGORY_COLOR } from '@/lib/server/catalog';
import { id, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

async function load(categoryId: string) {
  const user = await requireUser();
  const c = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!c) throw notFound('Categoría no encontrada');
  await assertEntityAccess(user, c.entityId);
  return c;
}

const patchSchema = z.object({
  name: shortText(80).optional(),
  color: z.string().max(7).optional().nullable(),
});

/** Renombra o cambia el color (lo ya etiquetado sigue apuntando a ella). */
export const PATCH = route<{ params: { id: string } }>(async (req, { params }) => {
  const c = await load(params.id);
  const data = patchSchema.parse(await readJson(req));
  if (data.color && !CATEGORY_COLOR.test(data.color)) throw badRequest('Color inválido');
  if (data.name !== undefined) await assertCategoryNameFree(prisma, c.entityId, c.direction, data.name, c.id);
  const updated = await prisma.category.update({
    where: { id: c.id },
    data: { name: data.name?.trim(), color: data.color },
  });
  return ok(updated);
});

const deleteSchema = z.object({ mergeInto: id.optional().nullable() });

/**
 * Elimina una categoría. Con `mergeInto`, antes pasa todo lo etiquetado (partidas, recurrencias y
 * consumos de tarjeta) a esa otra categoría (misma unidad y tipo); sin ella, lo etiquetado queda
 * "sin categoría". Nunca borra movimientos.
 */
export const DELETE = route<{ params: { id: string } }>(async (req, { params }) => {
  const c = await load(params.id);
  const { mergeInto } = deleteSchema.parse(await readJson(req).catch(() => ({})));
  const moved = await prisma.$transaction(async (tx) => {
    let count = 0;
    if (mergeInto) {
      if (mergeInto === c.id) throw badRequest('Elige otra categoría');
      const target = await tx.category.findUnique({ where: { id: mergeInto } });
      if (!target || target.entityId !== c.entityId || target.direction !== c.direction) {
        throw badRequest('La categoría destino debe ser de la misma unidad y del mismo tipo');
      }
      const where = { categoryId: c.id };
      const data = { categoryId: target.id };
      const [a, b, d] = await Promise.all([
        tx.obligation.updateMany({ where, data }),
        tx.recurringRule.updateMany({ where, data }),
        tx.cardCharge.updateMany({ where, data }),
      ]);
      count = a.count + b.count + d.count;
    }
    // Sin destino, la llave foránea deja lo etiquetado en NULL (onDelete: SetNull)
    await tx.category.delete({ where: { id: c.id } });
    return count;
  });
  return ok({ moved });
});
