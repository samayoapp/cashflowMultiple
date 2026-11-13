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
  /** Tarjeta bimoneda (HNL/USD): habilita el sub-saldo en la otra moneda. */
  dualCurrency: z.boolean().optional(),
  creditLimitForeign: nonNegativeMoney.optional().nullable(),
  /** Tasa de venta propia de la tarjeta (4 decimales); vacío = tasa global. */
  customSellRate: z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      if (v === null || String(v).trim() === '') return null;
      const s = String(v).trim();
      if (!/^\d+(\.\d{1,4})?$/.test(s) || Number(s) <= 0) {
        ctx.addIssue({ code: 'custom', message: 'Tasa inválida (hasta 4 decimales)' });
        return z.NEVER;
      }
      return s;
    }),
  /** Deuda inicial en la moneda extranjera (positivo). */
  openingDebtForeign: nonNegativeMoney.optional(),
};

/** Moneda extranjera de una tarjeta bimoneda según la moneda de la entidad (solo par HNL/USD). */
export function resolveForeignCurrency(dual: boolean | undefined, entityCurrency: string): string | null {
  if (!dual) return null;
  if (entityCurrency === 'HNL') return 'USD';
  if (entityCurrency === 'USD') return 'HNL';
  throw badRequest('Las tarjetas bimoneda solo están disponibles para entidades en HNL o USD');
}

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
