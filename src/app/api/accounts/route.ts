import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess, resolveContext } from '@/lib/server/scope';
import { accountDto } from '@/lib/server/dto';
import { dbDate, dec } from '@/lib/server/serialize';
import { getAccountBalances, getSettings } from '@/lib/server/projection-data';
import { id, isoDate, money, optionalText, shortText } from '@/lib/validation';
import { todayInTz } from '@/lib/dates';

export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const ctx = await resolveContext(user, url.searchParams.get('ctx'));
  const [accounts, balances] = await Promise.all([
    prisma.account.findMany({
      where: { entityId: { in: ctx.entityIds } },
      orderBy: [{ archivedAt: 'asc' }, { createdAt: 'asc' }],
    }),
    getAccountBalances(ctx.entityIds),
  ]);
  const byId = new Map(balances.map((b) => [b.accountId, b.balance]));
  return ok(accounts.map((a) => accountDto(a, byId.get(a.id) ?? 0)));
});

const createSchema = z.object({
  entityId: id,
  name: shortText(120),
  type: z.enum(['BANK', 'CASH', 'WALLET']).default('BANK'),
  institution: optionalText(120),
  openingBalance: money.default(0),
  openingDate: isoDate.optional(),
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const data = createSchema.parse(await readJson(req));
  await assertEntityAccess(user, data.entityId);
  const settings = await getSettings();
  const date = data.openingDate ?? todayInTz(settings.timezone);

  const account = await prisma.$transaction(async (tx) => {
    const a = await tx.account.create({
      data: { entityId: data.entityId, name: data.name, type: data.type, institution: data.institution },
    });
    if (data.openingBalance !== 0) {
      await tx.cashMovement.create({
        data: {
          entityId: a.entityId,
          accountId: a.id,
          type: 'OPENING',
          amount: dec(data.openingBalance),
          date: dbDate(date),
          description: 'Saldo de apertura',
          createdById: user.id,
        },
      });
    }
    return a;
  });
  return ok(accountDto(account, data.openingBalance), { status: 201 });
});
