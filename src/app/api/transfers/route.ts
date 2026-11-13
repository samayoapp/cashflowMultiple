import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess, resolveContext } from '@/lib/server/scope';
import { createTransfer } from '@/lib/server/services';
import { cents, isoOf, isoOrNull } from '@/lib/server/serialize';
import { id, isoDate, optionalText, positiveMoney } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  const user = await requireUser();
  const ctx = await resolveContext(user, new URL(req.url).searchParams.get('ctx'));
  const rows = await prisma.interEntityTransfer.findMany({
    where: { OR: [{ fromEntityId: { in: ctx.entityIds } }, { toEntityId: { in: ctx.entityIds } }] },
    orderBy: [{ status: 'asc' }, { expectedDate: 'asc' }],
    take: 500,
  });
  return ok(
    rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      fromEntityId: t.fromEntityId,
      toEntityId: t.toEntityId,
      amountFrom: cents(t.amountFrom),
      amountTo: cents(t.amountTo),
      expectedDate: isoOf(t.expectedDate),
      executedDate: isoOrNull(t.executedDate),
      description: t.description,
    })),
  );
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
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const data = schema.parse(await readJson(req));
  // Se requiere acceso a ambas entidades
  await assertEntityAccess(user, data.fromEntityId);
  await assertEntityAccess(user, data.toEntityId);
  const t = await createTransfer({
    kind: data.kind,
    fromEntityId: data.fromEntityId,
    toEntityId: data.toEntityId,
    amountFrom: data.amountFrom,
    amountTo: data.amountTo ?? data.amountFrom,
    expectedDate: data.expectedDate,
    description: data.description,
    userId: user.id,
  });
  return ok({ id: t.id }, { status: 201 });
});
