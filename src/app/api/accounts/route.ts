import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess, resolveContext } from '@/lib/server/scope';
import { accountDto } from '@/lib/server/dto';
import { dbDate, dec } from '@/lib/server/serialize';
import { getAccountBalances, getSettings } from '@/lib/server/projection-data';
import { id, isoDate, money, optionalText, shortText } from '@/lib/validation';
import { accountType, assertPaymentAccount, cardFields, refineCard, resolveForeignCurrency } from '@/lib/server/account-validation';
import { getCurrentFx } from '@/lib/server/fx';
import { rate4 } from '@/lib/projection/fx';
import { createOpeningDebt } from '@/lib/server/cards';
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
  const local = new Map<string, number>();
  const foreign = new Map<string, number>();
  for (const b of balances) {
    const m = b.currency ? foreign : local;
    m.set(b.accountId, (m.get(b.accountId) ?? 0) + b.balance);
  }
  return ok(accounts.map((a) => accountDto(a, local.get(a.id) ?? 0, foreign.get(a.id) ?? 0)));
});

const createSchema = z
  .object({
    entityId: id,
    name: shortText(120),
    type: accountType.default('BANK'),
    institution: optionalText(120),
    /** En tarjetas: deuda actual (positivo). */
    openingBalance: money.default(0),
    openingDate: isoDate.optional(),
    ...cardFields,
  })
  .superRefine(refineCard);

export const POST = route(async (req) => {
  const user = await requireUser();
  const data = createSchema.parse(await readJson(req));
  await assertEntityAccess(user, data.entityId);
  const settings = await getSettings();
  const date = data.openingDate ?? todayInTz(settings.timezone);

  const isCard = data.type === 'CREDIT_CARD';
  if (isCard && data.openingBalance < 0) throw badRequest('La deuda inicial no puede ser negativa');
  if (isCard) await assertPaymentAccount(data.defaultPaymentAccountId, data.entityId);
  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: data.entityId }, select: { currency: true } });
  const foreignCurrency = isCard ? resolveForeignCurrency(data.dualCurrency, entity.currency) : null;
  const fxRate = foreignCurrency
    ? (data.customSellRate ? rate4(data.customSellRate) : (await getCurrentFx())?.effective4 ?? null)
    : null;
  if (foreignCurrency && (data.openingDebtForeign ?? 0) > 0 && !fxRate) {
    throw badRequest('No hay tipo de cambio registrado para valuar la deuda inicial en moneda extranjera');
  }

  const account = await prisma.$transaction(async (tx) => {
    const a = await tx.account.create({
      data: {
        entityId: data.entityId,
        name: data.name,
        type: data.type,
        institution: data.institution,
        ...(isCard
          ? {
              creditLimit: data.creditLimit == null ? null : dec(data.creditLimit),
              statementDay: data.statementDay,
              paymentDueDay: data.paymentDueDay,
              defaultPaymentAccountId: data.defaultPaymentAccountId ?? null,
              foreignCurrency,
              creditLimitForeign: foreignCurrency && data.creditLimitForeign != null ? dec(data.creditLimitForeign) : null,
              customSellRate: foreignCurrency && data.customSellRate ? data.customSellRate : null,
            }
          : {}),
      },
    });
    if (isCard) {
      if (data.openingBalance > 0) await createOpeningDebt(tx, a, data.openingBalance, date, user.id);
      if (foreignCurrency && (data.openingDebtForeign ?? 0) > 0) {
        await createOpeningDebt(tx, a, data.openingDebtForeign!, date, user.id, { currency: foreignCurrency, rateAtTx: fxRate });
      }
    } else if (data.openingBalance !== 0) {
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
  return ok(
    accountDto(account, isCard ? -data.openingBalance : data.openingBalance, foreignCurrency ? -(data.openingDebtForeign ?? 0) : 0),
    { status: 201 },
  );
});
