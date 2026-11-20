import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { convertChargeToReimbursement } from '@/lib/server/cards';
import { id, isoDate, positiveMoney } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const schema = z.object({
  /** Unidad a la que corresponde el gasto (la que reembolsa). */
  entityId: id,
  /** Monto a reembolsar en la moneda de esa unidad. */
  amountFrom: positiveMoney,
  /** Monto que recibe la dueña de la tarjeta (su moneda). Por defecto, igual. */
  amountTo: positiveMoney.optional(),
  reimburseDate: isoDate,
  categoryId: id.optional().nullable(),
});

/**
 * "Este consumo es de otra unidad": convierte un consumo ya registrado en la tarjeta de una unidad
 * en gasto de otra, con su CxC/CxP de reembolso (pagadera por abonos).
 */
export const POST = route<{ params: { chargeId: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const charge = await prisma.cardCharge.findUnique({ where: { id: params.chargeId }, select: { entityId: true } });
  if (!charge) throw notFound('Consumo no encontrado');
  await assertEntityAccess(user, charge.entityId);
  const data = schema.parse(await readJson(req));
  await assertEntityAccess(user, data.entityId);
  const result = await convertChargeToReimbursement({
    chargeId: params.chargeId,
    entityId: data.entityId,
    amountFrom: data.amountFrom,
    amountTo: data.amountTo ?? data.amountFrom,
    reimburseDate: data.reimburseDate,
    categoryId: data.categoryId ?? null,
    userId: user.id,
  });
  return ok(result, { status: 201 });
});
