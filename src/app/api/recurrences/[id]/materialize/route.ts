import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { materializeOccurrence } from '@/lib/server/services';
import { obligationDto, obligationInclude } from '@/lib/server/dto';
import { isoDate } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** Convierte una ocurrencia virtual en partida real para pagarla, moverla o editarla. */
export const POST = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const r = await prisma.recurringRule.findUnique({ where: { id: params.id }, select: { entityId: true } });
  if (!r) throw notFound('Recurrencia no encontrada');
  await assertEntityAccess(user, r.entityId);
  const { date } = z.object({ date: isoDate }).parse(await readJson(req));
  const ob = await materializeOccurrence(params.id, date, user.id);
  const full = await prisma.obligation.findUniqueOrThrow({ where: { id: ob.id }, include: obligationInclude });
  return ok(obligationDto(full));
});
