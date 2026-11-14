import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess, resolveContext } from '@/lib/server/scope';
import { cents, isoOf } from '@/lib/server/serialize';
import { createInternalTransfer } from '@/lib/server/services';
import { getSettings } from '@/lib/server/projection-data';
import { id, isoDate, optionalText, positiveMoney } from '@/lib/validation';
import { todayInTz } from '@/lib/dates';

export const dynamic = 'force-dynamic';

/** Transferencias entre cuentas de las entidades del contexto (más recientes primero). */
export const GET = route(async (req) => {
  const user = await requireUser();
  const ctx = await resolveContext(user, new URL(req.url).searchParams.get('ctx'));
  const rows = await prisma.accountTransfer.findMany({
    where: { entityId: { in: ctx.entityIds } },
    include: { fromAccount: { select: { name: true } }, toAccount: { select: { name: true } } },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  });
  return ok(
    rows.map((t) => ({
      id: t.id,
      entityId: t.entityId,
      status: t.status,
      fromAccountName: t.fromAccount.name,
      toAccountName: t.toAccount.name,
      amount: cents(t.amount),
      date: isoOf(t.date),
      description: t.description,
    })),
  );
});

const schema = z.object({
  entityId: id,
  fromAccountId: id,
  toAccountId: id,
  amount: positiveMoney,
  date: isoDate.optional(),
  description: optionalText(200),
});

/** Transferencia entre cuentas de una misma entidad (se ejecuta al momento). */
export const POST = route(async (req) => {
  const user = await requireUser();
  const data = schema.parse(await readJson(req));
  await assertEntityAccess(user, data.entityId);
  const settings = await getSettings();
  const t = await createInternalTransfer({
    entityId: data.entityId,
    fromAccountId: data.fromAccountId,
    toAccountId: data.toAccountId,
    amount: data.amount,
    date: data.date ?? todayInTz(settings.timezone),
    description: data.description ?? null,
    userId: user.id,
  });
  return ok({ id: t.id }, { status: 201 });
});
