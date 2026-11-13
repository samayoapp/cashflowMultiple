import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { payCreditCard } from '@/lib/server/cards';
import { getSettings } from '@/lib/server/projection-data';
import { id, isoDate, optionalText, positiveMoney } from '@/lib/validation';
import { todayInTz } from '@/lib/dates';

export const dynamic = 'force-dynamic';

const schema = z.object({
  fromAccountId: id,
  amount: positiveMoney,
  date: isoDate.optional(),
  note: optionalText(300),
});

/** Pago de la tarjeta desde una cuenta líquida (no genera un gasto nuevo). */
export const POST = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const card = await prisma.account.findUnique({ where: { id: params.id } });
  if (!card) throw notFound('Tarjeta no encontrada');
  await assertEntityAccess(user, card.entityId);
  const data = schema.parse(await readJson(req));
  const settings = await getSettings();
  const result = await payCreditCard({
    cardId: card.id,
    fromAccountId: data.fromAccountId,
    amount: data.amount,
    date: data.date ?? todayInTz(settings.timezone),
    note: data.note,
    userId: user.id,
  });
  return ok(result, { status: 201 });
});
