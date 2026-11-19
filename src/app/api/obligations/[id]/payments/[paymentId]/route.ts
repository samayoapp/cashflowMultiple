import { prisma } from '@/lib/server/db';
import { notFound, ok, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { deletePayment } from '@/lib/server/services';
import { obligationDto, obligationInclude } from '@/lib/server/dto';

export const dynamic = 'force-dynamic';

/** Deshace un cobro/pago registrado por error (quita también su movimiento de caja). */
export const DELETE = route<{ params: { id: string; paymentId: string } }>(async (_req, { params }) => {
  const user = await requireUser();
  const o = await prisma.obligation.findUnique({ where: { id: params.id }, select: { entityId: true } });
  if (!o) throw notFound('Partida no encontrada');
  await assertEntityAccess(user, o.entityId);
  await deletePayment(params.id, params.paymentId);
  const updated = await prisma.obligation.findUniqueOrThrow({ where: { id: params.id }, include: obligationInclude });
  return ok(obligationDto(updated));
});
