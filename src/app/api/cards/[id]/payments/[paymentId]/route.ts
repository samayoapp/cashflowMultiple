import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { undoCardPayment, updateCardPayment } from '@/lib/server/cards';
import { id, isoDate } from '@/lib/validation';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string; paymentId: string } };

async function loadCard(cardId: string) {
  const user = await requireUser();
  const card = await prisma.account.findUnique({ where: { id: cardId } });
  if (!card) throw notFound('Tarjeta no encontrada');
  await assertEntityAccess(user, card.entityId);
  return card;
}

const schema = z.object({
  date: isoDate.optional(),
  /** Omitida = no cambia; vacía o null = se borra. */
  note: z
    .string()
    .trim()
    .max(300)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
  fromAccountId: id.optional(),
});

/** Corrige fecha, nota o cuenta de origen de un pago (sus montos no cambian). */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const card = await loadCard(params.id);
  const data = schema.parse(await readJson(req));
  return ok(await updateCardPayment({ cardId: card.id, paymentId: params.paymentId, ...data }));
});

/** Deshace el pago completo: devuelve el dinero al banco y la deuda a la tarjeta. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const card = await loadCard(params.id);
  return ok(await undoCardPayment({ cardId: card.id, paymentId: params.paymentId }));
});
