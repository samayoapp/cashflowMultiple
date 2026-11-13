import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, conflict, notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { resolveCounterparty } from '@/lib/server/catalog';
import { cents, dbDate, dec, isoOrNull } from '@/lib/server/serialize';
import { direction, isoDate, positiveMoney, priority } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reject') }),
  z.object({
    action: z.literal('approve'),
    // Campos opcionales para completar/corregir lo recibido antes de aprobar
    direction: direction.optional(),
    description: z.string().trim().min(1).max(200).optional(),
    amount: positiveMoney.optional(),
    dueDate: isoDate.optional(),
    expectedDate: isoDate.optional(),
    counterpartyName: z.string().trim().max(160).optional(),
    priority: priority.default('FLEXIBLE'),
  }),
]);

/** Aprueba (crea la CxC/CxP real) o rechaza un elemento de la bandeja. */
export const POST = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const item = await prisma.stagingItem.findUnique({ where: { id: params.id } });
  if (!item) throw notFound('Elemento no encontrado');
  await assertEntityAccess(user, item.entityId);
  if (item.status !== 'PENDING') throw conflict('Este elemento ya fue revisado');
  const data = schema.parse(await readJson(req));

  if (data.action === 'reject') {
    await prisma.stagingItem.update({
      where: { id: item.id },
      data: { status: 'REJECTED', reviewedById: user.id, reviewedAt: new Date() },
    });
    return ok({ status: 'REJECTED' });
  }

  const dir = data.direction ?? item.direction;
  const description = data.description ?? item.description;
  const amount = data.amount ?? (item.amount ? cents(item.amount) : null);
  const dueDate = data.dueDate ?? isoOrNull(item.dueDate);
  const expectedDate = data.expectedDate ?? isoOrNull(item.expectedDate) ?? dueDate;
  if (!dir || !description || !amount || !dueDate || !expectedDate) {
    throw badRequest('Completa tipo, descripción, monto y fecha antes de aprobar');
  }

  const obligation = await prisma.$transaction(async (tx) => {
    // Bloqueo para evitar doble aprobación concurrente
    await tx.$queryRaw`SELECT id FROM "StagingItem" WHERE id = ${item.id} FOR UPDATE`;
    const fresh = await tx.stagingItem.findUniqueOrThrow({ where: { id: item.id } });
    if (fresh.status !== 'PENDING') throw conflict('Este elemento ya fue revisado');

    const counterpartyId = await resolveCounterparty(
      tx,
      item.entityId,
      { counterpartyName: data.counterpartyName ?? item.counterparty },
      dir === 'IN' ? 'CUSTOMER' : 'SUPPLIER',
    );
    const ob = await tx.obligation.create({
      data: {
        entityId: item.entityId,
        direction: dir,
        description,
        amount: dec(amount),
        dueDate: dbDate(dueDate),
        expectedDate: dbDate(expectedDate),
        priority: data.priority,
        counterpartyId: counterpartyId ?? null,
        stagingItemId: item.id,
        notes: item.source ? `Origen: ${item.source}${item.externalId ? ` (${item.externalId})` : ''}` : null,
        createdById: user.id,
      },
    });
    await tx.stagingItem.update({
      where: { id: item.id },
      data: { status: 'APPROVED', reviewedById: user.id, reviewedAt: new Date() },
    });
    return ob;
  });
  return ok({ status: 'APPROVED', obligationId: obligation.id });
});
