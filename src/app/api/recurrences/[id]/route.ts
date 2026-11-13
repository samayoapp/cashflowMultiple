import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { dbDate, dec, isoOf } from '@/lib/server/serialize';
import { frequency, isoDate, positiveMoney, priority, shortText } from '@/lib/validation';
import { ruleDto, ruleInclude } from '@/lib/server/dto';

export const dynamic = 'force-dynamic';

const schema = z.object({
  description: shortText(200).optional(),
  amount: positiveMoney.optional(),
  frequency: frequency.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional().nullable(),
  priority: priority.optional(),
  active: z.boolean().optional(),
});

/** Los cambios aplican a ocurrencias futuras no materializadas. */
export const PATCH = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const r = await prisma.recurringRule.findUnique({ where: { id: params.id } });
  if (!r) throw notFound('Recurrencia no encontrada');
  await assertEntityAccess(user, r.entityId);
  const data = schema.parse(await readJson(req));
  const start = data.startDate ?? isoOf(r.startDate);
  const end = data.endDate === undefined ? (r.endDate ? isoOf(r.endDate) : null) : data.endDate;
  if (end && end < start) throw badRequest('La fecha final es anterior al inicio');

  const updated = await prisma.recurringRule.update({
    where: { id: r.id },
    data: {
      description: data.description,
      amount: data.amount !== undefined ? dec(data.amount) : undefined,
      frequency: data.frequency,
      startDate: data.startDate ? dbDate(data.startDate) : undefined,
      endDate: data.endDate === undefined ? undefined : data.endDate ? dbDate(data.endDate) : null,
      priority: data.priority,
      active: data.active,
    },
    include: ruleInclude,
  });
  return ok(ruleDto(updated));
});
