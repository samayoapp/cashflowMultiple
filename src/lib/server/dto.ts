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

export function accountDto(a: Account, balance: number) {
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
  };
}
export type AccountDto = ReturnType<typeof accountDto>;

export const obligationInclude = {
  payments: { orderBy: { date: 'asc' as const }, include: { account: { select: { name: true } } } },
  counterparty: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
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
    notes: o.notes,
    payments: o.payments.map((p) => ({
      id: p.id,
      amount: cents(p.amount),
      date: isoOf(p.date),
      accountId: p.accountId,
      accountName: p.account.name,
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
