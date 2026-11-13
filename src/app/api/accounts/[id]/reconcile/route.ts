import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { reconcileAccount } from '@/lib/server/services';
import { getSettings } from '@/lib/server/projection-data';
import { isoDate, money } from '@/lib/validation';
import { todayInTz } from '@/lib/dates';

export const dynamic = 'force-dynamic';

const schema = z.object({ actualBalance: money, date: isoDate.optional(), currency: z.enum(['HNL', 'USD']).optional().nullable() });

/** Conciliación rápida: registra un ajuste para que el saldo real coincida con el banco. */
export const POST = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const a = await prisma.account.findUnique({ where: { id: params.id } });
  if (!a) throw notFound('Cuenta no encontrada');
  await assertEntityAccess(user, a.entityId);
  const data = schema.parse(await readJson(req));
  const settings = await getSettings();
  const result = await reconcileAccount({
    accountId: a.id,
    actualBalance: data.actualBalance,
    currency: data.currency ?? null,
    date: data.date ?? todayInTz(settings.timezone),
    userId: user.id,
  });
  return ok(result);
});
