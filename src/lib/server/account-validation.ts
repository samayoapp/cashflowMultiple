import { z } from 'zod';
import { prisma } from './db';
import { badRequest } from './api';
import { id, nonNegativeMoney } from '@/lib/validation';

export const accountType = z.enum(['BANK', 'CASH', 'WALLET', 'CREDIT_CARD']);

const day = z.coerce.number().int().min(1, 'Día entre 1 y 31').max(31, 'Día entre 1 y 31');

/** Campos propios de las tarjetas de crédito (se ignoran en cuentas líquidas). */
export const cardFields = {
  creditLimit: nonNegativeMoney.optional().nullable(),
  statementDay: day.optional().nullable(),
  paymentDueDay: day.optional().nullable(),
  defaultPaymentAccountId: id.optional().nullable(),
};

export function refineCard(
  v: { type: string; statementDay?: number | null; paymentDueDay?: number | null },
  ctx: z.RefinementCtx,
) {
  if (v.type !== 'CREDIT_CARD') return;
  if (!v.statementDay) ctx.addIssue({ code: 'custom', path: ['statementDay'], message: 'Indica el día de corte' });
  if (!v.paymentDueDay) ctx.addIssue({ code: 'custom', path: ['paymentDueDay'], message: 'Indica el día límite de pago' });
}

/** La cuenta de pago por defecto debe ser líquida y de la misma entidad. */
export async function assertPaymentAccount(accountId: string | null | undefined, entityId: string) {
  if (!accountId) return;
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acc || acc.entityId !== entityId) throw badRequest('La cuenta de pago no pertenece a la entidad');
  if (acc.type === 'CREDIT_CARD') throw badRequest('La cuenta de pago debe ser una cuenta líquida');
}
