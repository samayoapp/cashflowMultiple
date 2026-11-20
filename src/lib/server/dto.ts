import type { Account, Entity, Prisma } from '@prisma/client';
import { cents, isoOf, isoOrNull } from './serialize';

/** Formas JSON que expone la API. Montos en centavos (number), fechas ISO. */

export function entityDto(e: Entity) {
  return {
    id: e.id,
    name: e.name,
    currency: e.currency,
    color: e.color,
    minCashThreshold: cents(e.minCashThreshold),
    isDefault: e.isDefault,
    archived: Boolean(e.archivedAt),
    webhookEnabled: Boolean(e.webhookTokenHash),
    webhookTokenHint: e.webhookTokenHint,
  };
}
export type EntityDto = ReturnType<typeof entityDto>;

export function accountDto(a: Account, balance: number, balanceForeign = 0) {
  return {
    id: a.id,
    entityId: a.entityId,
    name: a.name,
    type: a.type,
    institution: a.institution,
    archived: Boolean(a.archivedAt),
    /** En tarjetas: negativo = deuda. */
    balance,
    creditLimit: a.creditLimit ? cents(a.creditLimit) : null,
    statementDay: a.statementDay,
    paymentDueDay: a.paymentDueDay,
    defaultPaymentAccountId: a.defaultPaymentAccountId,
    /** Tarjeta bimoneda: segunda moneda y su sub-saldo (negativo = deuda). */
    foreignCurrency: a.foreignCurrency,
    balanceForeign,
    creditLimitForeign: a.creditLimitForeign ? cents(a.creditLimitForeign) : null,
    customSellRate: a.customSellRate ? Number(a.customSellRate.toString()).toFixed(4) : null,
    /** Tope de gasto por ciclo de facturación (moneda de la entidad). */
    cycleBudget: a.cycleBudget ? cents(a.cycleBudget) : null,
  };
}
export type AccountDto = ReturnType<typeof accountDto>;

export const obligationInclude = {
  payments: { orderBy: { date: 'asc' as const }, include: { account: { select: { name: true, type: true } } } },
  counterparty: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
  transfer: { select: { id: true, fromEntityId: true, toEntityId: true, repaymentOfId: true, isReimbursement: true, status: true } },
} satisfies Prisma.ObligationInclude;

type ObligationWith = Prisma.ObligationGetPayload<{ include: typeof obligationInclude }>;

export function obligationDto(o: ObligationWith) {
  const paid = o.payments.reduce((s, p) => s + cents(p.amount), 0);
  const amount = cents(o.amount);
  return {
    id: o.id,
    entityId: o.entityId,
    direction: o.direction,
    description: o.description,
    amount,
    paid,
    remaining: Math.max(amount - paid, 0),
    dueDate: isoOf(o.dueDate),
    expectedDate: isoOf(o.expectedDate),
    status: o.status,
    priority: o.priority,
    isHypothetical: o.isHypothetical,
    counterparty: o.counterparty,
    category: o.category,
    recurrenceId: o.recurrenceId,
    occurrenceDate: isoOrNull(o.occurrenceDate),
    transferId: o.transferId,
    /** Devolución de préstamo o reembolso entre unidades (se opera con abonos de transferencia). */
    interUnit:
      o.transfer && (o.transfer.repaymentOfId || o.transfer.isReimbursement)
        ? {
            transferId: o.transfer.id,
            kind: o.transfer.repaymentOfId ? ('LOAN' as const) : ('REIMBURSEMENT' as const),
            fromEntityId: o.transfer.fromEntityId,
            toEntityId: o.transfer.toEntityId,
          }
        : null,
    notes: o.notes,
    payments: o.payments.map((p) => ({
      id: p.id,
      amount: cents(p.amount),
      date: isoOf(p.date),
      accountId: p.accountId,
      accountName: p.account.name,
      byCard: p.account.type === 'CREDIT_CARD',
      note: p.note,
    })),
  };
}
export type ObligationDto = ReturnType<typeof obligationDto>;

export const ruleInclude = {
  counterparty: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
} satisfies Prisma.RecurringRuleInclude;

export function ruleDto(r: Prisma.RecurringRuleGetPayload<{ include: typeof ruleInclude }>) {
  return {
    id: r.id,
    entityId: r.entityId,
    direction: r.direction,
    description: r.description,
    amount: cents(r.amount),
    frequency: r.frequency,
    startDate: isoOf(r.startDate),
    endDate: isoOrNull(r.endDate),
    priority: r.priority,
    active: r.active,
    counterparty: r.counterparty,
    category: r.category,
  };
}
export type RuleDto = ReturnType<typeof ruleDto>;

/** Ocurrencia futura de una recurrencia que aún no existe como CxC/CxP (ver /api/recurrences/upcoming). */
export interface UpcomingOccurrenceDto {
  key: string;
  ruleId: string;
  entityId: string;
  direction: RuleDto['direction'];
  description: string;
  amount: number;
  date: string;
  frequency: RuleDto['frequency'];
  priority: RuleDto['priority'];
  counterparty: RuleDto['counterparty'];
  category: RuleDto['category'];
  /** Fecha ya pasada que nunca se registró como cobro/pago. */
  past: boolean;
}

export const transferInclude = {
  obligations: { select: { direction: true, amount: true, payments: { select: { amount: true } } } },
  repayment: { select: { id: true, status: true } },
} satisfies Prisma.InterEntityTransferInclude;

type TransferWith = Prisma.InterEntityTransferGetPayload<{ include: typeof transferInclude }>;

/** Transferencia entre unidades con lo abonado/pendiente de cada lado (préstamos y devoluciones). */
export function transferDto(t: TransferWith) {
  const side = (dir: 'OUT' | 'IN') => {
    const o = t.obligations.find((x) => x.direction === dir);
    const paid = o ? o.payments.reduce((s, p) => s + cents(p.amount), 0) : 0;
    return { paid, remaining: o ? Math.max(cents(o.amount) - paid, 0) : 0 };
  };
  const out = side('OUT');
  const inn = side('IN');
  return {
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
    /** Es la devolución del préstamo indicado. */
    repaymentOfId: t.repaymentOfId,
    /** Reembolso de un gasto pagado con tarjeta de la unidad destino. */
    isReimbursement: t.isReimbursement,
    interest: cents(t.interestAmount),
    /** Préstamo: su devolución (si ya se programó). */
    repayment: t.repayment,
    paidFrom: out.paid,
    remainingFrom: out.remaining,
    paidTo: inn.paid,
    remainingTo: inn.remaining,
  };
}
export type TransferDto = ReturnType<typeof transferDto>;
