import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { accountDto } from '@/lib/server/dto';
import { cents, dec, isoOf } from '@/lib/server/serialize';
import { accountType, assertPaymentAccount, cardFields, resolveForeignCurrency } from '@/lib/server/account-validation';
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
  const [agg, aggForeign, movements] = await Promise.all([
    prisma.cashMovement.aggregate({ where: { accountId: a.id, currency: null }, _sum: { amount: true } }),
    prisma.cashMovement.aggregate({ where: { accountId: a.id, currency: { not: null } }, _sum: { amount: true } }),
    prisma.cashMovement.findMany({
      where: { accountId: a.id },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    }),
  ]);
  return ok({
    ...accountDto(a, cents(agg._sum.amount), cents(aggForeign._sum.amount)),
    movements: movements.map((m) => ({
      id: m.id,
      type: m.type,
      amount: cents(m.amount),
      currency: m.currency,
      date: isoOf(m.date),
      description: m.description,
      transferId: m.transferId,
    })),
  });
});

const patchSchema = z.object({
  name: shortText(120).optional(),
  type: accountType.optional(),
  institution: optionalText(120),
  archived: z.boolean().optional(),
  ...cardFields,
});

export const PATCH = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const a = await loadAccount(params.id);
  await assertEntityAccess(user, a.entityId);
  const data = patchSchema.parse(await readJson(req));
  const nextType = data.type ?? a.type;
  if (data.type && data.type !== a.type && (a.type === 'CREDIT_CARD' || data.type === 'CREDIT_CARD')) {
    const used = await prisma.cashMovement.count({ where: { accountId: a.id } });
    if (used > 0) throw badRequest('No se puede convertir una cuenta con movimientos en tarjeta (ni al revés)');
  }
  const isCard = nextType === 'CREDIT_CARD';
  if (isCard) {
    const merged = {
      type: nextType,
      statementDay: data.statementDay === undefined ? a.statementDay : data.statementDay,
      paymentDueDay: data.paymentDueDay === undefined ? a.paymentDueDay : data.paymentDueDay,
    };
    if (!merged.statementDay || !merged.paymentDueDay) throw badRequest('La tarjeta requiere día de corte y día de pago');
    if (data.defaultPaymentAccountId) await assertPaymentAccount(data.defaultPaymentAccountId, a.entityId);
  }
  // Activar/desactivar bimoneda: desactivar solo si el sub-saldo extranjero no tiene movimientos
  let foreignChange: string | null | undefined;
  if (isCard && data.dualCurrency !== undefined) {
    const entity = await prisma.entity.findUniqueOrThrow({ where: { id: a.entityId }, select: { currency: true } });
    foreignChange = resolveForeignCurrency(data.dualCurrency, entity.currency);
    if (!foreignChange && a.foreignCurrency) {
      const used = await prisma.cashMovement.count({ where: { accountId: a.id, currency: a.foreignCurrency } });
      if (used > 0) throw badRequest('La tarjeta ya tiene movimientos en moneda extranjera; no se puede quitar la bimoneda');
    }
  }
  const updated = await prisma.account.update({
    where: { id: a.id },
    data: {
      name: data.name,
      type: data.type,
      institution: data.institution === null ? undefined : data.institution,
      archivedAt: data.archived === undefined ? undefined : data.archived ? new Date() : null,
      ...(isCard
        ? {
            creditLimit: data.creditLimit === undefined ? undefined : data.creditLimit === null ? null : dec(data.creditLimit),
            statementDay: data.statementDay ?? undefined,
            paymentDueDay: data.paymentDueDay ?? undefined,
            defaultPaymentAccountId: data.defaultPaymentAccountId,
            ...(foreignChange !== undefined ? { foreignCurrency: foreignChange } : {}),
            creditLimitForeign:
              data.creditLimitForeign === undefined ? undefined : data.creditLimitForeign === null ? null : dec(data.creditLimitForeign),
            customSellRate: data.customSellRate,
          }
        : {}),
    },
  });
  const [agg, aggForeign] = await Promise.all([
    prisma.cashMovement.aggregate({ where: { accountId: a.id, currency: null }, _sum: { amount: true } }),
    prisma.cashMovement.aggregate({ where: { accountId: a.id, currency: { not: null } }, _sum: { amount: true } }),
  ]);
  return ok(accountDto(updated, cents(agg._sum.amount), cents(aggForeign._sum.amount)));
});
