import { z } from 'zod';
import { badRequest, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { createReimbursedExpense } from '@/lib/server/cards';
import { id, isoDate, positiveMoney, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const schema = z.object({
  entityId: id,
  purchaseDate: isoDate,
  reimburseDate: isoDate,
  description: shortText(200),
  amount: positiveMoney,
  categoryId: id.optional().nullable(),
  counterpartyName: z.string().trim().max(160).optional().nullable(),
  owner: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('PERSON'), name: shortText(160) }),
    z.object({
      kind: z.literal('ENTITY'),
      entityId: id,
      /** Monto en la moneda de la entidad dueña (si difiere). Por defecto igual. */
      amountTo: positiveMoney.optional(),
      cardAccountId: id.optional().nullable(),
    }),
  ]),
});

/**
 * Gasto pagado con la tarjeta de un tercero: registra el gasto (con su categoría)
 * y la CxP de reembolso a favor de la persona o entidad dueña de la tarjeta.
 */
export const POST = route(async (req) => {
  const user = await requireUser();
  const data = schema.parse(await readJson(req));
  await assertEntityAccess(user, data.entityId);
  if (data.reimburseDate < data.purchaseDate) throw badRequest('El reembolso no puede ser anterior al gasto');
  const owner =
    data.owner.kind === 'PERSON'
      ? data.owner
      : { ...data.owner, amountTo: data.owner.amountTo ?? data.amount };
  if (owner.kind === 'ENTITY') await assertEntityAccess(user, owner.entityId);
  const result = await createReimbursedExpense({ ...data, owner, userId: user.id });
  return ok(result, { status: 201 });
});
