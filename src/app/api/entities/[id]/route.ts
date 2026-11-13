import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { conflict, notFound, ok, readJson, route } from '@/lib/server/api';
import { requireAdmin } from '@/lib/server/auth';
import { entityDto } from '@/lib/server/dto';
import { dec } from '@/lib/server/serialize';
import { currency, hexColor, nonNegativeMoney, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: shortText(120).optional(),
  color: hexColor.optional(),
  minCashThreshold: nonNegativeMoney.optional(),
  currency: currency.optional(),
  archived: z.boolean().optional(),
});

export const PATCH = route<{ params: { id: string } }>(async (req, { params }) => {
  await requireAdmin();
  const data = patchSchema.parse(await readJson(req));
  const entity = await prisma.entity.findUnique({ where: { id: params.id } });
  if (!entity) throw notFound('Entidad no encontrada');

  if (data.currency && data.currency !== entity.currency) {
    const [movements, obligations] = await Promise.all([
      prisma.cashMovement.count({ where: { entityId: entity.id } }),
      prisma.obligation.count({ where: { entityId: entity.id } }),
    ]);
    if (movements + obligations > 0) {
      throw conflict('No se puede cambiar la moneda de una entidad que ya tiene movimientos o partidas');
    }
  }
  if (data.archived && entity.isDefault) throw conflict('La Entidad Base no se puede archivar');

  const updated = await prisma.entity.update({
    where: { id: entity.id },
    data: {
      name: data.name,
      color: data.color,
      currency: data.currency,
      minCashThreshold: data.minCashThreshold !== undefined ? dec(data.minCashThreshold) : undefined,
      archivedAt: data.archived === undefined ? undefined : data.archived ? new Date() : null,
    },
  });
  return ok(entityDto(updated));
});
