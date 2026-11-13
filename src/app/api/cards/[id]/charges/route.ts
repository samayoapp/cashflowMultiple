import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { createCardCharge, MAX_INSTALLMENTS } from '@/lib/server/cards';
import { id, isoDate, positiveMoney, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const schema = z.object({
  purchaseDate: isoDate,
  description: shortText(200),
  amount: positiveMoney,
  installments: z.coerce.number().int().min(1).max(MAX_INSTALLMENTS).default(1),
  /** HNL / USD; por defecto la moneda de la entidad. */
  currency: z.enum(['HNL', 'USD']).optional().nullable(),
  categoryId: id.optional().nullable(),
  counterpartyId: id.optional().nullable(),
  counterpartyName: z.string().trim().max(160).optional().nullable(),
});

/** Registra un consumo con la tarjeta (no afecta la caja real hasta su fecha de pago). */
export const POST = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const card = await prisma.account.findUnique({ where: { id: params.id } });
  if (!card) throw notFound('Tarjeta no encontrada');
  await assertEntityAccess(user, card.entityId);
  const data = schema.parse(await readJson(req));
  const { charge, schedule } = await createCardCharge({ cardId: card.id, ...data, userId: user.id });
  return ok({ id: charge.id, schedule }, { status: 201 });
});
