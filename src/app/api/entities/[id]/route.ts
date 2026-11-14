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
  if (!entity) throw notFound('Unidad de negocio no encontrada');

  if (data.currency && data.currency !== entity.currency) {
    const [movements, obligations] = await Promise.all([
      prisma.cashMovement.count({ where: { entityId: entity.id } }),
      prisma.obligation.count({ where: { entityId: entity.id } }),
    ]);
    if (movements + obligations > 0) {
      throw conflict('No se puede cambiar la moneda de una unidad de negocio que ya tiene movimientos o partidas');
    }
  }
  if (data.archived && entity.isDefault) throw conflict('La unidad de negocio Base no se puede archivar');

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

/**
 * Elimina una entidad VACÍA (sin cuentas, partidas, movimientos, recurrencias, transferencias,
 * tarjetas ni bandeja). Si tiene cualquier dato operativo, se debe archivar en su lugar.
 * La Entidad Base no se elimina: primero se define otra como Base.
 * Su catálogo sin uso (contrapartes, categorías) y los accesos de usuario se eliminan con ella.
 */
export const DELETE = route<{ params: { id: string } }>(async (_req, { params }) => {
  await requireAdmin();
  const entity = await prisma.entity.findUnique({ where: { id: params.id } });
  if (!entity) throw notFound('Unidad de negocio no encontrada');
  if (entity.isDefault) throw conflict('La unidad de negocio Base no se puede eliminar. Define otra unidad de negocio como Base primero.');

  await prisma.$transaction(async (tx) => {
    const where = { entityId: entity.id };
    const [accounts, obligations, movements, rules, staging, accTransfers, charges, installments, cardPayments, transfers] =
      await Promise.all([
        tx.account.count({ where }),
        tx.obligation.count({ where }),
        tx.cashMovement.count({ where }),
        tx.recurringRule.count({ where }),
        tx.stagingItem.count({ where }),
        tx.accountTransfer.count({ where }),
        tx.cardCharge.count({ where }),
        tx.cardInstallment.count({ where }),
        tx.cardPayment.count({ where }),
        tx.interEntityTransfer.count({ where: { OR: [{ fromEntityId: entity.id }, { toEntityId: entity.id }] } }),
      ]);
    const found = [
      [accounts, 'cuentas'],
      [obligations, 'CxC/CxP'],
      [movements, 'movimientos'],
      [rules, 'recurrencias'],
      [transfers + accTransfers, 'transferencias'],
      [charges + installments + cardPayments, 'registros de tarjeta'],
      [staging, 'partidas en la bandeja de integraciones'],
    ]
      .filter(([n]) => (n as number) > 0)
      .map(([n, label]) => `${n} ${label}`);
    if (found.length) {
      throw conflict(`No se puede eliminar "${entity.name}": tiene ${found.join(', ')}. Archívala en su lugar.`);
    }
    await tx.counterparty.deleteMany({ where });
    await tx.category.deleteMany({ where });
    await tx.userEntityAccess.deleteMany({ where });
    await tx.entity.delete({ where: { id: entity.id } });
  });
  return ok({ deleted: true });
});
