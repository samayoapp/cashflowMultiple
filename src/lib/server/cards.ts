import type { Account, Prisma } from '@prisma/client';
import { prisma } from './db';
import { badRequest, conflict, notFound } from './api';
import { cents, dbDate, dec, isoOf } from './serialize';
import { assertCategory, resolveCounterparty } from './catalog';
import { createTransferTx } from './services';
import {
  allocatePayment,
  buildSchedule,
  nextDayOnOrAfter,
  statementCloseFor,
  statementForDueDate,
  type CardCycleConfig,
} from '@/lib/projection/card-cycle';
import type { ISODate } from '@/lib/dates';
import type { Cents } from '@/lib/money';

type Tx = Prisma.TransactionClient;

export const MAX_INSTALLMENTS = 36;

/** Valida que la cuenta sea una tarjeta utilizable y devuelve su ciclo. */
export function cardCycleOf(card: Account): CardCycleConfig {
  if (card.type !== 'CREDIT_CARD') throw badRequest('La cuenta no es una tarjeta de crédito');
  if (card.archivedAt) throw badRequest('La tarjeta está archivada');
  if (!card.statementDay || !card.paymentDueDay) throw badRequest('Configura el día de corte y el día de pago de la tarjeta');
  return { statementDay: card.statementDay, paymentDueDay: card.paymentDueDay };
}

async function lockCard(tx: Tx, cardId: string) {
  await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${cardId} FOR UPDATE`;
  const card = await tx.account.findUnique({ where: { id: cardId } });
  if (!card) throw notFound('Tarjeta no encontrada');
  return card;
}

/**
 * Crea el consumo y sus cuotas a partir de un movimiento ya registrado en la tarjeta.
 * Reutilizado por: consumo directo, CxP pagada con tarjeta, deuda inicial y reembolsos.
 */
export async function insertCardCharge(
  tx: Tx,
  args: {
    card: Account;
    purchaseDate: ISODate;
    description: string;
    amount: Cents;
    installments: number;
    categoryId?: string | null;
    counterpartyId?: string | null;
    obligationId?: string | null;
    movementId: string;
    isOpening?: boolean;
    /** Solo deuda inicial: fecha de pago fija (no se calcula por corte). */
    fixedDueDate?: ISODate;
    userId: string;
  },
) {
  const cycle = cardCycleOf(args.card);
  if (!Number.isInteger(args.installments) || args.installments < 1 || args.installments > MAX_INSTALLMENTS) {
    throw badRequest(`Las cuotas deben estar entre 1 y ${MAX_INSTALLMENTS}`);
  }
  const schedule = args.fixedDueDate
    ? [
        {
          number: 1,
          count: 1,
          amount: args.amount,
          statementDate: statementForDueDate(args.fixedDueDate, cycle),
          dueDate: args.fixedDueDate,
        },
      ]
    : buildSchedule(args.purchaseDate, args.amount, args.installments, cycle);

  const charge = await tx.cardCharge.create({
    data: {
      entityId: args.card.entityId,
      cardAccountId: args.card.id,
      purchaseDate: dbDate(args.purchaseDate),
      description: args.description,
      amount: dec(args.amount),
      installments: schedule.length,
      categoryId: args.categoryId ?? null,
      counterpartyId: args.counterpartyId ?? null,
      obligationId: args.obligationId ?? null,
      movementId: args.movementId,
      isOpening: Boolean(args.isOpening),
      createdById: args.userId,
    },
  });
  await tx.cardInstallment.createMany({
    data: schedule.map((s) => ({
      chargeId: charge.id,
      entityId: args.card.entityId,
      cardAccountId: args.card.id,
      number: s.number,
      count: s.count,
      amount: dec(s.amount),
      statementDate: dbDate(s.statementDate),
      dueDate: dbDate(s.dueDate),
    })),
  });
  return { charge, schedule };
}

/** Deuda inicial al crear la tarjeta: se proyecta en la próxima fecha de pago desde hoy. */
export async function createOpeningDebt(tx: Tx, card: Account, debt: Cents, today: ISODate, userId: string) {
  const cycle = cardCycleOf(card);
  const mv = await tx.cashMovement.create({
    data: {
      entityId: card.entityId,
      accountId: card.id,
      type: 'OPENING',
      amount: dec(-debt),
      date: dbDate(today),
      description: 'Deuda inicial de la tarjeta',
      createdById: userId,
    },
  });
  await insertCardCharge(tx, {
    card,
    purchaseDate: today,
    description: 'Saldo inicial',
    amount: debt,
    installments: 1,
    movementId: mv.id,
    isOpening: true,
    fixedDueDate: nextDayOnOrAfter(today, cycle.paymentDueDay),
    userId,
  });
}

/** Consumo con tarjeta: aumenta la deuda, no toca la caja real y conserva la categoría. */
export async function createCardCharge(args: {
  cardId: string;
  purchaseDate: ISODate;
  description: string;
  amount: Cents;
  installments: number;
  categoryId?: string | null;
  counterpartyId?: string | null;
  counterpartyName?: string | null;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const card = await lockCard(tx, args.cardId);
    cardCycleOf(card);
    const counterpartyId = await resolveCounterparty(tx, card.entityId, args, 'SUPPLIER');
    const categoryId = await assertCategory(tx, card.entityId, args.categoryId);
    if (categoryId) {
      const cat = await tx.category.findUnique({ where: { id: categoryId } });
      if (cat?.direction !== 'OUT') throw badRequest('La categoría debe ser de egreso');
    }
    const mv = await tx.cashMovement.create({
      data: {
        entityId: card.entityId,
        accountId: card.id,
        type: 'PAYMENT',
        amount: dec(-args.amount),
        date: dbDate(args.purchaseDate),
        description: `Consumo: ${args.description}`,
        createdById: args.userId,
      },
    });
    return insertCardCharge(tx, {
      card,
      purchaseDate: args.purchaseDate,
      description: args.description,
      amount: args.amount,
      installments: args.installments,
      categoryId: categoryId ?? null,
      counterpartyId: counterpartyId ?? null,
      movementId: mv.id,
      userId: args.userId,
    });
  });
}

/**
 * Pago (liquidación) de la tarjeta desde una cuenta líquida de la misma entidad.
 * Mueve caja real y reduce la deuda; NO crea un gasto categorizado (evita doble contabilidad).
 */
export async function payCreditCard(args: {
  cardId: string;
  fromAccountId: string;
  amount: Cents;
  date: ISODate;
  note?: string | null;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const card = await lockCard(tx, args.cardId);
    if (card.type !== 'CREDIT_CARD') throw badRequest('La cuenta destino no es una tarjeta de crédito');
    const from = await tx.account.findUnique({ where: { id: args.fromAccountId } });
    if (!from || from.entityId !== card.entityId) throw badRequest('La cuenta de origen no pertenece a la entidad');
    if (from.type === 'CREDIT_CARD') throw badRequest('Una tarjeta no puede pagarse con otra tarjeta');
    if (from.archivedAt) throw badRequest('La cuenta de origen está archivada');

    const agg = await tx.cashMovement.aggregate({ where: { accountId: card.id }, _sum: { amount: true } });
    const debt = -cents(agg._sum.amount);
    if (debt <= 0) throw conflict('La tarjeta no tiene deuda pendiente');
    if (args.amount > debt) throw badRequest('El pago supera la deuda de la tarjeta');

    const pending = await tx.cardInstallment.findMany({
      where: { cardAccountId: card.id },
      include: { charge: { select: { purchaseDate: true } } },
    });
    const { allocations } = allocatePayment(
      pending.map((i) => ({
        id: i.id,
        dueDate: isoOf(i.dueDate),
        number: i.number,
        purchaseDate: isoOf(i.charge.purchaseDate),
        pending: cents(i.amount) - cents(i.settledAmount),
      })),
      args.amount,
    );

    const label = `Pago Tarjeta: ${card.name}`;
    const date = dbDate(args.date);
    const bankMv = await tx.cashMovement.create({
      data: {
        entityId: card.entityId,
        accountId: from.id,
        type: 'CARD_PAYMENT',
        amount: dec(-args.amount),
        date,
        description: label,
        createdById: args.userId,
      },
    });
    const cardMv = await tx.cashMovement.create({
      data: {
        entityId: card.entityId,
        accountId: card.id,
        type: 'CARD_PAYMENT',
        amount: dec(args.amount),
        date,
        description: `${label} (desde ${from.name})`,
        createdById: args.userId,
      },
    });
    const payment = await tx.cardPayment.create({
      data: {
        entityId: card.entityId,
        cardAccountId: card.id,
        fromAccountId: from.id,
        amount: dec(args.amount),
        date,
        bankMovementId: bankMv.id,
        cardMovementId: cardMv.id,
        note: args.note ?? null,
        createdById: args.userId,
      },
    });
    for (const a of allocations) {
      await tx.cardPaymentAllocation.create({
        data: { paymentId: payment.id, installmentId: a.installmentId, amount: dec(a.amount) },
      });
      await tx.cardInstallment.update({
        where: { id: a.installmentId },
        data: { settledAmount: { increment: dec(a.amount) } },
      });
    }
    return { paymentId: payment.id, remainingDebt: debt - args.amount, allocated: allocations.length };
  });
}

/**
 * Gasto pagado por un tercero (persona u otra entidad): registra el gasto con su categoría
 * y la CxP de reembolso a favor del dueño de la tarjeta.
 */
export async function createReimbursedExpense(args: {
  entityId: string;
  purchaseDate: ISODate;
  reimburseDate: ISODate;
  description: string;
  amount: Cents;
  categoryId?: string | null;
  counterpartyName?: string | null;
  owner:
    | { kind: 'PERSON'; name: string }
    | { kind: 'ENTITY'; entityId: string; amountTo: Cents; cardAccountId?: string | null };
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const categoryId = await assertCategory(tx, args.entityId, args.categoryId);
    const supplier = args.counterpartyName?.trim();
    const label = `Reembolso: ${args.description}${supplier ? ` (${supplier})` : ''}`;

    if (args.owner.kind === 'PERSON') {
      const counterpartyId = await resolveCounterparty(tx, args.entityId, { counterpartyName: args.owner.name }, 'SUPPLIER');
      const ob = await tx.obligation.create({
        data: {
          entityId: args.entityId,
          direction: 'OUT',
          description: label,
          amount: dec(args.amount),
          dueDate: dbDate(args.reimburseDate),
          expectedDate: dbDate(args.reimburseDate),
          priority: 'FIXED',
          counterpartyId: counterpartyId ?? null,
          categoryId: categoryId ?? null,
          notes: `Gasto del ${args.purchaseDate} pagado con tarjeta de ${args.owner.name}`,
          createdById: args.userId,
        },
      });
      return { obligationId: ob.id, transferId: null };
    }

    const owner = args.owner;
    if (owner.entityId === args.entityId) throw badRequest('La entidad dueña debe ser distinta');
    const t = await createTransferTx(tx, {
      kind: 'TRANSFER',
      fromEntityId: args.entityId,
      toEntityId: owner.entityId,
      amountFrom: args.amount,
      amountTo: owner.amountTo,
      expectedDate: args.reimburseDate,
      description: label,
      userId: args.userId,
      outCategoryId: categoryId ?? null,
    });

    // Opcional: el consumo en la tarjeta de la entidad dueña, SIN categoría (el gasto ya
    // está clasificado en la entidad que lo reembolsa; así no se cuenta dos veces).
    if (owner.cardAccountId) {
      const card = await lockCard(tx, owner.cardAccountId);
      if (card.entityId !== owner.entityId) throw badRequest('La tarjeta no pertenece a la entidad dueña');
      const mv = await tx.cashMovement.create({
        data: {
          entityId: card.entityId,
          accountId: card.id,
          type: 'PAYMENT',
          amount: dec(-owner.amountTo),
          date: dbDate(args.purchaseDate),
          description: `Consumo (a reembolsar): ${args.description}`,
          createdById: args.userId,
        },
      });
      await insertCardCharge(tx, {
        card,
        purchaseDate: args.purchaseDate,
        description: `${args.description} (reembolsable)`,
        amount: owner.amountTo,
        installments: 1,
        movementId: mv.id,
        userId: args.userId,
      });
    }
    return { obligationId: null, transferId: t.id };
  });
}

/** Resumen por tarjeta para la vista "Tarjetas". */
export async function getCardsSummary(entityIds: string[], today: ISODate) {
  const cards = await prisma.account.findMany({
    where: { entityId: { in: entityIds }, type: 'CREDIT_CARD' },
    orderBy: [{ archivedAt: 'asc' }, { createdAt: 'asc' }],
  });
  if (cards.length === 0) return [];
  const ids = cards.map((c) => c.id);
  const [balances, installments, payments] = await Promise.all([
    prisma.cashMovement.groupBy({ by: ['accountId'], where: { accountId: { in: ids } }, _sum: { amount: true } }),
    prisma.cardInstallment.findMany({
      where: { cardAccountId: { in: ids } },
      include: {
        charge: {
          select: {
            id: true,
            description: true,
            purchaseDate: true,
            amount: true,
            isOpening: true,
            obligationId: true,
            category: { select: { name: true } },
            counterparty: { select: { name: true } },
          },
        },
      },
      orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
    }),
    prisma.cardPayment.findMany({
      where: { cardAccountId: { in: ids } },
      include: { fromAccount: { select: { name: true } } },
      orderBy: { date: 'desc' },
      take: 200,
    }),
  ]);
  const balanceOf = new Map(balances.map((b) => [b.accountId, cents(b._sum.amount)]));

  return cards.map((card) => {
    const debt = Math.max(-(balanceOf.get(card.id) ?? 0), 0);
    const mine = installments.filter((i) => i.cardAccountId === card.id);
    const currentClose = card.statementDay ? statementCloseFor(today, card.statementDay) : null;

    const groups = new Map<string, { dueDate: ISODate; statementDate: ISODate; total: Cents; pending: Cents; items: unknown[] }>();
    let pendingTotal = 0;
    let currentCycle = 0;
    for (const i of mine) {
      const amount = cents(i.amount);
      const pending = amount - cents(i.settledAmount);
      const dueDate = isoOf(i.dueDate);
      const statementDate = isoOf(i.statementDate);
      pendingTotal += pending;
      if (currentClose && statementDate === currentClose && !i.charge.isOpening) currentCycle += amount;
      const g = groups.get(dueDate) ?? { dueDate, statementDate, total: 0, pending: 0, items: [] };
      g.total += amount;
      g.pending += pending;
      g.items.push({
        installmentId: i.id,
        chargeId: i.chargeId,
        description: i.charge.description,
        categoryName: i.charge.category?.name ?? null,
        counterpartyName: i.charge.counterparty?.name ?? null,
        purchaseDate: isoOf(i.charge.purchaseDate),
        chargeAmount: cents(i.charge.amount),
        isOpening: i.charge.isOpening,
        fromObligation: Boolean(i.charge.obligationId),
        number: i.number,
        count: i.count,
        amount,
        pending,
      });
      groups.set(dueDate, g);
    }
    const statements = Array.from(groups.values()).map((g) => ({
      ...g,
      status: g.pending === 0 ? 'PAID' : g.dueDate < today ? 'OVERDUE' : g.pending < g.total ? 'PARTIAL' : 'OPEN',
    }));
    const next = statements.find((s) => s.pending > 0) ?? null;
    const limit = card.creditLimit ? cents(card.creditLimit) : null;

    return {
      id: card.id,
      entityId: card.entityId,
      name: card.name,
      institution: card.institution,
      archived: Boolean(card.archivedAt),
      statementDay: card.statementDay,
      paymentDueDay: card.paymentDueDay,
      defaultPaymentAccountId: card.defaultPaymentAccountId,
      creditLimit: limit,
      available: limit === null ? null : limit - debt,
      debt,
      pendingInstallments: pendingTotal,
      currentCycle,
      currentStatementDate: currentClose,
      nextPayment: next ? { dueDate: next.dueDate, pending: next.pending } : null,
      statements,
      payments: payments
        .filter((p) => p.cardAccountId === card.id)
        .map((p) => ({ id: p.id, date: isoOf(p.date), amount: cents(p.amount), fromAccountName: p.fromAccount.name, note: p.note })),
    };
  });
}
export type CardSummaryDto = Awaited<ReturnType<typeof getCardsSummary>>[number];
