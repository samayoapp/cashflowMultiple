import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { accountDto } from '@/lib/server/dto';
import { cents, isoOf } from '@/lib/server/serialize';
import { optionalText, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

async function loadAccount(id: string) {
  const a = await prisma.account.findUnique({ where: { id } });
  if (!a) throw notFound('Cuenta no encontrada');
  return a;
}

/** Detalle de la cuenta con sus últimos movimientos reales. */
export const GET = route<{ params: { id: string } }>(async (_req, { params }) => {
  const user = await requireUser();
  const a = await loadAccount(params.id);
  await assertEntityAccess(user, a.entityId);
  const [agg, movements] = await Promise.all([
    prisma.cashMovement.aggregate({ where: { accountId: a.id }, _sum: { amount: true } }),
    prisma.cashMovement.findMany({
      where: { accountId: a.id },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    }),
  ]);
  return ok({
    ...accountDto(a, cents(agg._sum.amount)),
    movements: movements.map((m) => ({
      id: m.id,
      type: m.type,
      amount: cents(m.amount),
      date: isoOf(m.date),
      description: m.description,
      transferId: m.transferId,
    })),
  });
});

const patchSchema = z.object({
  name: shortText(120).optional(),
  type: z.enum(['BANK', 'CASH', 'WALLET']).optional(),
  institution: optionalText(120),
  archived: z.boolean().optional(),
});

export const PATCH = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const a = await loadAccount(params.id);
  await assertEntityAccess(user, a.entityId);
  const data = patchSchema.parse(await readJson(req));
  const updated = await prisma.account.update({
    where: { id: a.id },
    data: {
      name: data.name,
      type: data.type,
      institution: data.institution === null ? undefined : data.institution,
      archivedAt: data.archived === undefined ? undefined : data.archived ? new Date() : null,
    },
  });
  const agg = await prisma.cashMovement.aggregate({ where: { accountId: a.id }, _sum: { amount: true } });
  return ok(accountDto(updated, cents(agg._sum.amount)));
});
