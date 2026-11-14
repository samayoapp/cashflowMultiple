import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, conflict, notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { resolveCounterparty } from '@/lib/server/catalog';
import { cents, dbDate, dec, isoOrNull } from '@/lib/server/serialize';
import { direction, id, isoDate, positiveMoney, priority } from '@/lib/validation';
import { createCardCharge } from '@/lib/server/cards';
import { getSettings } from '@/lib/server/projection-data';
import { todayInTz } from '@/lib/dates';

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
  // Aprobar como consumo con tarjeta (en la moneda detectada: HNL o USD)
  z.object({
    action: z.literal('approve_card'),
    cardAccountId: id,
    installments: z.coerce.number().int().min(1).max(36).default(1),
    categoryId: id.optional().nullable(),
    purchaseDate: isoDate.optional(),
    description: z.string().trim().min(1).max(200).optional(),
    amount: positiveMoney.optional(),
    currency: z.enum(['HNL', 'USD']).optional(),
    counterpartyName: z.string().trim().max(160).optional(),
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

  if (data.action === 'approve_card') {
    const card = await prisma.account.findUnique({ where: { id: data.cardAccountId } });
    if (!card || card.entityId !== item.entityId) throw badRequest('La tarjeta no pertenece a la unidad de negocio del elemento');
    const description = data.description ?? item.description;
    const amount = data.amount ?? (item.amount ? cents(item.amount) : null);
    if (!description || !amount) throw badRequest('Completa descripción y monto antes de aprobar');
    const settings = await getSettings();
    const purchaseDate = data.purchaseDate ?? isoOrNull(item.dueDate) ?? todayInTz(settings.timezone);
    const charge = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "StagingItem" WHERE id = ${item.id} FOR UPDATE`;
      const fresh = await tx.stagingItem.findUniqueOrThrow({ where: { id: item.id } });
      if (fresh.status !== 'PENDING') throw conflict('Este elemento ya fue revisado');
      const r = await createCardCharge({
        tx,
        cardId: card.id,
        purchaseDate,
        description,
        amount,
        installments: data.installments,
        currency: data.currency ?? item.currency,
        categoryId: data.categoryId ?? null,
        counterpartyName: data.counterpartyName ?? item.counterparty,
        userId: user.id,
      });
      await tx.stagingItem.update({
        where: { id: item.id },
        data: { status: 'APPROVED', reviewedById: user.id, reviewedAt: new Date() },
      });
      return r.charge;
    });
    return ok({ status: 'APPROVED', cardChargeId: charge.id });
  }

  const dir = data.direction ?? item.direction;
  // Una CxC/CxP vive en la moneda de la entidad: si llegó en otra moneda, hay que corregir el monto
  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: item.entityId }, select: { currency: true } });
  if (item.currency && item.currency !== entity.currency && data.amount === undefined) {
    throw badRequest(
      `El monto llegó en ${item.currency}: ingresa el equivalente en ${entity.currency} o apruébalo como consumo con tarjeta`,
    );
  }
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
