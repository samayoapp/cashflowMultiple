import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess, resolveContext } from '@/lib/server/scope';
import { dbDate, dec } from '@/lib/server/serialize';
import { ruleDto, ruleInclude as include } from '@/lib/server/dto';
import { assertCategory, resolveCounterparty } from '@/lib/server/catalog';
import { direction, frequency, id, isoDate, positiveMoney, priority, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  const user = await requireUser();
  const ctx = await resolveContext(user, new URL(req.url).searchParams.get('ctx'));
  const rows = await prisma.recurringRule.findMany({
    where: { entityId: { in: ctx.entityIds } },
    include,
    orderBy: [{ active: 'desc' }, { startDate: 'asc' }],
  });
  return ok(rows.map(ruleDto));
});

const createSchema = z.object({
  entityId: id,
  direction,
  description: shortText(200),
  amount: positiveMoney,
  frequency,
  startDate: isoDate,
  endDate: isoDate.optional().nullable(),
  priority: priority.default('FLEXIBLE'),
  counterpartyId: id.optional().nullable(),
  counterpartyName: z.string().trim().max(160).optional().nullable(),
  categoryId: id.optional().nullable(),
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const data = createSchema.parse(await readJson(req));
  await assertEntityAccess(user, data.entityId);
  if (data.endDate && data.endDate < data.startDate) throw badRequest('La fecha final es anterior al inicio');
  const rule = await prisma.$transaction(async (tx) => {
    const counterpartyId = await resolveCounterparty(
      tx,
      data.entityId,
      data,
      data.direction === 'IN' ? 'CUSTOMER' : 'SUPPLIER',
    );
    const categoryId = await assertCategory(tx, data.entityId, data.categoryId);
    return tx.recurringRule.create({
      data: {
        entityId: data.entityId,
        direction: data.direction,
        description: data.description,
        amount: dec(data.amount),
        frequency: data.frequency,
        startDate: dbDate(data.startDate),
        endDate: data.endDate ? dbDate(data.endDate) : null,
        priority: data.priority,
        counterpartyId: counterpartyId ?? null,
        categoryId: categoryId ?? null,
      },
      include,
    });
  });
  return ok(ruleDto(rule), { status: 201 });
});
