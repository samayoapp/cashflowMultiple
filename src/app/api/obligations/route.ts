import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/server/db';
import { ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess, resolveContext } from '@/lib/server/scope';
import { obligationDto, obligationInclude } from '@/lib/server/dto';
import { dbDate, dec } from '@/lib/server/serialize';
import { assertCategory, resolveCounterparty } from '@/lib/server/catalog';
import { direction, id, isoDate, optionalText, positiveMoney, priority, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * Lista CxC/CxP del contexto.
 * ?direction=IN|OUT  ?status=open|closed|all  ?transfers=include|only|exclude  ?q=texto
 */
export const GET = route(async (req) => {
  const user = await requireUser();
  const sp = new URL(req.url).searchParams;
  const ctx = await resolveContext(user, sp.get('ctx'));
  const status = sp.get('status') ?? 'open';
  const dir = sp.get('direction');
  const transfers = sp.get('transfers') ?? 'include';
  const q = sp.get('q')?.trim();

  const where: Prisma.ObligationWhereInput = {
    entityId: { in: ctx.entityIds },
    ...(dir === 'IN' || dir === 'OUT' ? { direction: dir } : {}),
    ...(status === 'open'
      ? { status: { in: ['OPEN', 'PARTIAL'] } }
      : status === 'closed'
        ? { status: { in: ['SETTLED', 'CANCELLED'] } }
        : {}),
    ...(transfers === 'exclude' ? { transferId: null } : transfers === 'only' ? { transferId: { not: null } } : {}),
    ...(q
      ? {
          OR: [
            { description: { contains: q, mode: 'insensitive' } },
            { counterparty: { name: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const rows = await prisma.obligation.findMany({
    where,
    include: obligationInclude,
    orderBy: [{ expectedDate: 'asc' }, { createdAt: 'asc' }],
    take: 1000,
  });
  return ok(rows.map(obligationDto));
});

const createSchema = z.object({
  entityId: id,
  direction,
  description: shortText(200),
  amount: positiveMoney,
  dueDate: isoDate,
  expectedDate: isoDate.optional(),
  priority: priority.default('FLEXIBLE'),
  isHypothetical: z.boolean().default(false),
  counterpartyId: id.optional().nullable(),
  counterpartyName: z.string().trim().max(160).optional().nullable(),
  categoryId: id.optional().nullable(),
  notes: optionalText(1000),
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const data = createSchema.parse(await readJson(req));
  await assertEntityAccess(user, data.entityId);

  const created = await prisma.$transaction(async (tx) => {
    const counterpartyId = await resolveCounterparty(
      tx,
      data.entityId,
      data,
      data.direction === 'IN' ? 'CUSTOMER' : 'SUPPLIER',
    );
    const categoryId = await assertCategory(tx, data.entityId, data.categoryId);
    return tx.obligation.create({
      data: {
        entityId: data.entityId,
        direction: data.direction,
        description: data.description,
        amount: dec(data.amount),
        dueDate: dbDate(data.dueDate),
        expectedDate: dbDate(data.expectedDate ?? data.dueDate),
        priority: data.priority,
        isHypothetical: data.isHypothetical,
        counterpartyId: counterpartyId ?? null,
        categoryId: categoryId ?? null,
        notes: data.notes,
        createdById: user.id,
      },
      include: obligationInclude,
    });
  });
  return ok(obligationDto(created), { status: 201 });
});
