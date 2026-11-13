import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { payCreditCard } from '@/lib/server/cards';
import { getSettings } from '@/lib/server/projection-data';
import { id, isoDate, nonNegativeMoney, optionalText } from '@/lib/validation';
import { rate4 } from '@/lib/projection/fx';
import { todayInTz } from '@/lib/dates';

export const dynamic = 'force-dynamic';

const schema = z
  .object({
    fromAccountId: id,
    /** Monto aplicado al sub-saldo en la moneda de la entidad. `amount` se acepta como alias. */
    amountBase: nonNegativeMoney.optional(),
    amount: nonNegativeMoney.optional(),
    /** Monto abonado al sub-saldo en moneda extranjera (tarjetas bimoneda). */
    amountForeign: nonNegativeMoney.optional(),
    /** Tasa real aplicada por el banco (4 decimales). */
    fxRate: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v, ctx) => {
        if (v === undefined || String(v).trim() === '') return undefined;
        try {
          const r = rate4(String(v).trim());
          if (r <= 0) throw new Error();
          return r;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Tasa inválida' });
          return z.NEVER;
        }
      }),
    date: isoDate.optional(),
    note: optionalText(300),
  })
  .refine((d) => (d.amountBase ?? d.amount ?? 0) > 0 || (d.amountForeign ?? 0) > 0, 'Indica el monto a pagar');

/** Pago de la tarjeta desde una cuenta líquida (no genera un gasto nuevo). */
export const POST = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const card = await prisma.account.findUnique({ where: { id: params.id } });
  if (!card) throw notFound('Tarjeta no encontrada');
  await assertEntityAccess(user, card.entityId);
  const data = schema.parse(await readJson(req));
  const settings = await getSettings();
  const result = await payCreditCard({
    cardId: card.id,
    fromAccountId: data.fromAccountId,
    amountBase: data.amountBase ?? data.amount ?? 0,
    amountForeign: data.amountForeign ?? 0,
    fxRate: data.fxRate ?? null,
    date: data.date ?? todayInTz(settings.timezone),
    note: data.note,
    userId: user.id,
  });
  return ok(result, { status: 201 });
});
