import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess, resolveContext } from '@/lib/server/scope';
import { createTransfer } from '@/lib/server/services';
import { transferDto, transferInclude } from '@/lib/server/dto';
import { badRequest } from '@/lib/server/api';
import { id, isoDate, nonNegativeMoney, optionalText, positiveMoney } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  const user = await requireUser();
  const ctx = await resolveContext(user, new URL(req.url).searchParams.get('ctx'));
  const rows = await prisma.interEntityTransfer.findMany({
    where: { OR: [{ fromEntityId: { in: ctx.entityIds } }, { toEntityId: { in: ctx.entityIds } }] },
    include: transferInclude,
    orderBy: [{ status: 'asc' }, { expectedDate: 'asc' }],
    take: 500,
  });
  return ok(rows.map(transferDto));
});

const schema = z.object({
  kind: z.enum(['LOAN', 'CONTRIBUTION', 'TRANSFER']).default('TRANSFER'),
  fromEntityId: id,
  toEntityId: id,
  amountFrom: positiveMoney,
  /** Si las monedas son distintas, monto recibido en moneda destino. Por defecto igual al origen. */
  amountTo: positiveMoney.optional(),
  expectedDate: isoDate,
  description: optionalText(200),
  /** Solo préstamos: fecha límite de devolución (genera CxC en quien presta y CxP en quien recibe). */
  repaymentDate: isoDate.optional().nullable(),
  /** Interés total pactado, en la moneda de quien presta (por defecto 0). */
  interest: nonNegativeMoney.optional(),
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const data = schema.parse(await readJson(req));
  // Se requiere acceso a ambas entidades
  await assertEntityAccess(user, data.fromEntityId);
  await assertEntityAccess(user, data.toEntityId);
  if (data.repaymentDate && data.kind !== 'LOAN') throw badRequest('Solo los préstamos tienen devolución');
  if (data.repaymentDate && data.repaymentDate < data.expectedDate) throw badRequest('La devolución no puede ser antes de la entrega del préstamo');
  const t = await createTransfer({
    kind: data.kind,
    fromEntityId: data.fromEntityId,
    toEntityId: data.toEntityId,
    amountFrom: data.amountFrom,
    amountTo: data.amountTo ?? data.amountFrom,
    expectedDate: data.expectedDate,
    description: data.description,
    repayment: data.repaymentDate ? { dueDate: data.repaymentDate, interest: data.interest ?? 0 } : null,
    userId: user.id,
  });
  return ok({ id: t.id }, { status: 201 });
});
