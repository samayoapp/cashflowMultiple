import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { conflict, notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { executeTransfer } from '@/lib/server/services';
import { getSettings } from '@/lib/server/projection-data';
import { id, isoDate } from '@/lib/validation';
import { todayInTz } from '@/lib/dates';

export const dynamic = 'force-dynamic';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('execute'), fromAccountId: id, toAccountId: id, date: isoDate.optional() }),
  z.object({ action: z.literal('cancel') }),
]);

/** Ejecuta (mueve caja real en ambas entidades) o cancela una transferencia planificada. */
export const POST = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const t = await prisma.interEntityTransfer.findUnique({ where: { id: params.id } });
  if (!t) throw notFound('Transferencia no encontrada');
  await assertEntityAccess(user, t.fromEntityId);
  await assertEntityAccess(user, t.toEntityId);
  const data = schema.parse(await readJson(req));

  if (data.action === 'cancel') {
    if (t.status !== 'PLANNED') throw conflict('Solo se cancelan transferencias planificadas');
    await prisma.$transaction([
      prisma.obligation.updateMany({ where: { transferId: t.id }, data: { status: 'CANCELLED' } }),
      prisma.interEntityTransfer.update({ where: { id: t.id }, data: { status: 'CANCELLED' } }),
    ]);
    return ok({ status: 'CANCELLED' });
  }

  const settings = await getSettings();
  const updated = await executeTransfer({
    transferId: t.id,
    fromAccountId: data.fromAccountId,
    toAccountId: data.toAccountId,
    date: data.date ?? todayInTz(settings.timezone),
    userId: user.id,
  });
  return ok({ status: updated.status });
});
