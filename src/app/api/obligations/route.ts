import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/server/db';
import { ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess, resolveContext } from '@/lib/server/scope';
import { obligationDto, obligationInclude } from '@/lib/server/dto';
import { dbDate, dec } from '@/lib/server/serialize';
import { assertCategory, resolveCounterparty } from '@/lib/server/catalog';
import { registerPaymentTx } from '@/lib/server/services';
import { badRequest } from '@/lib/server/api';
import { isISODate } from '@/lib/dates';
import { direction, id, isoDate, optionalText, positiveMoney, priority, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * Lista CxC/CxP del contexto.
 * ?direction=IN|OUT  ?status=open|closed|all  ?transfers=include|only|exclude|loans  ?q=texto
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD  período por fecha de vencimiento (ambos opcionales)
 * ?order=asc|desc  por fecha esperada (default asc)   ?limit=N (default 1000, máx. 5000)
 */
export const GET = route(async (req) => {
  const user = await requireUser();
  const sp = new URL(req.url).searchParams;
  const ctx = await resolveContext(user, sp.get('ctx'));
  const status = sp.get('status') ?? 'open';
  const dir = sp.get('direction');
  const transfers = sp.get('transfers') ?? 'include';
  const q = sp.get('q')?.trim();
  const from = sp.get('from');
  const to = sp.get('to');
  if ((from && !isISODate(from)) || (to && !isISODate(to))) throw badRequest('Período inválido');
  const order = sp.get('order') === 'desc' ? 'desc' : 'asc';
  const limit = Math.min(Math.max(Number(sp.get('limit')) || 1000, 1), 5000);

  const where: Prisma.ObligationWhereInput = {
    entityId: { in: ctx.entityIds },
    ...(dir === 'IN' || dir === 'OUT' ? { direction: dir } : {}),
    ...(status === 'open'
      ? { status: { in: ['OPEN', 'PARTIAL'] } }
      : status === 'closed'
        ? { status: { in: ['SETTLED', 'CANCELLED'] } }
        : {}),
    ...(from || to ? { dueDate: { ...(from ? { gte: dbDate(from) } : {}), ...(to ? { lte: dbDate(to) } : {}) } } : {}),
    ...(transfers === 'exclude'
      ? { transferId: null }
      : transfers === 'only'
        ? { transferId: { not: null } }
        : transfers === 'loans'
          ? // Partidas normales + devoluciones de préstamos y reembolsos entre unidades (se cobran/pagan por abonos)
            { OR: [{ transferId: null }, { transfer: { repaymentOfId: { not: null } } }, { transfer: { isReimbursement: true } }] }
          : {}),
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
    orderBy: [{ expectedDate: order }, { createdAt: order }],
    take: limit,
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
  /** Historia: la partida nace ya pagada/cobrada completa desde esta cuenta y fecha. */
  settlement: z.object({ accountId: id, date: isoDate }).optional().nullable(),
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
    if (data.settlement && data.isHypothetical) throw badRequest('Una partida hipotética no puede nacer liquidada');
    const ob = await tx.obligation.create({
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
    });
    if (data.settlement) {
      await registerPaymentTx(tx, {
        obligationId: ob.id,
        accountId: data.settlement.accountId,
        amount: data.amount,
        date: data.settlement.date,
        userId: user.id,
      });
    }
    return tx.obligation.findUniqueOrThrow({ where: { id: ob.id }, include: obligationInclude });
  });
  return ok(obligationDto(created), { status: 201 });
});
