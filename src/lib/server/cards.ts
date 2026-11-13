import { randomUUID } from 'node:crypto';
import type { Account, Prisma } from '@prisma/client';
import { prisma } from './db';
import { badRequest, conflict, notFound } from './api';
import { cents, dbDate, dec, isoOf } from './serialize';
import { assertCategory, resolveCounterparty } from './catalog';
import { createTransferTx } from './services';
import { cardRateFor, getCurrentFx } from './fx';
import {
  allocatePayment,
  buildSchedule,
  nextDayOnOrAfter,
  statementCloseFor,
  statementForDueDate,
  type CardCycleConfig,
} from '@/lib/projection/card-cycle';
import { convertPair, fxDifference, rate4, rateToString, type Rate4 } from '@/lib/projection/fx';
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

async function entityCurrency(tx: Tx, entityId: string) {
  const e = await tx.entity.findUnique({ where: { id: entityId }, select: { currency: true } });
  if (!e) throw notFound('Entidad no encontrada');
  return e.currency;
}

/**
 * Moneda de un consumo: null = moneda de la entidad; si no, debe ser la moneda extranjera de la tarjeta.
 */
function foreignOf(card: Account, base: string, currency?: string | null): string | null {
  if (!currency || currency === base) return null;
  if (card.foreignCurrency !== currency) {
    throw badRequest(`La tarjeta ${card.name} no acepta consumos en ${currency}${card.foreignCurrency ? '' : ' (no es bimoneda)'}`);
  }
  return currency;
}

/** Tasa de venta vigente de la tarjeta; obligatoria para operar en moneda extranjera. */
async function requireCardRate(card: Account): Promise<Rate4> {
  const r = cardRateFor(card, await getCurrentFx());
  if (!r) throw badRequest('No hay tipo de cambio registrado: sincronízalo o ingrésalo manualmente');
  return r;
}

/** Suma del saldo de la tarjeta en una moneda (null = moneda de la entidad). Negativo = deuda. */
async function cardBalance(tx: Tx, cardId: string, currency: string | null) {
  const agg = await tx.cashMovement.aggregate({ where: { accountId: cardId, currency }, _sum: { amount: true } });
  return cents(agg._sum.amount);
}

/**
 * Crea el consumo y sus cuotas a partir de un movimiento ya registrado en la tarjeta.
 * Reutilizado por: consumo directo, CxP pagada con tarjeta, deuda inicial, reembolsos y bandeja.
 */
export async function insertCardCharge(
  tx: Tx,
  args: {
    card: Account;
    purchaseDate: ISODate;
    description: string;
    amount: Cents; // en la moneda del consumo
    installments: number;
    /** null = moneda de la entidad */
    currency?: string | null;
    rateAtTx?: Rate4 | null;
    amountBase?: Cents;
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
  const currency = args.currency ?? null;

  const charge = await tx.cardCharge.create({
    data: {
      entityId: args.card.entityId,
      cardAccountId: args.card.id,
      purchaseDate: dbDate(args.purchaseDate),
      description: args.description,
      amount: dec(args.amount),
      installments: schedule.length,
      currency,
      exchangeRateAtTx: args.rateAtTx ? rateToString(args.rateAtTx) : null,
      amountBase: dec(args.amountBase ?? args.amount),
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
      currency,
      statementDate: dbDate(s.statementDate),
      dueDate: dbDate(s.dueDate),
    })),
  });
  return { charge, schedule };
}

/** Deuda inicial al crear la tarjeta (en lempiras o en la moneda extranjera): se proyecta en el próximo pago. */
export async function createOpeningDebt(
  tx: Tx,
  card: Account,
  debt: Cents,
  today: ISODate,
  userId: string,
  opts: { currency?: string | null; rateAtTx?: Rate4 | null } = {},
) {
  const cycle = cardCycleOf(card);
  const currency = opts.currency ?? null;
  const mv = await tx.cashMovement.create({
    data: {
      entityId: card.entityId,
      accountId: card.id,
      type: 'OPENING',
      amount: dec(-debt),
      currency,
      date: dbDate(today),
      description: `Deuda inicial de la tarjeta${currency ? ` (${currency})` : ''}`,
      createdById: userId,
    },
  });
  const base = await entityCurrency(tx, card.entityId);
  await insertCardCharge(tx, {
    card,
    purchaseDate: today,
    description: currency ? `Saldo inicial ${currency}` : 'Saldo inicial',
    amount: debt,
    installments: 1,
    currency,
    rateAtTx: currency ? (opts.rateAtTx ?? null) : null,
    amountBase: currency && opts.rateAtTx ? convertPair(debt, currency, base, opts.rateAtTx) : debt,
    movementId: mv.id,
    isOpening: true,
    fixedDueDate: nextDayOnOrAfter(today, cycle.paymentDueDay),
    userId,
  });
}

/** Consumo con tarjeta: aumenta la deuda en su moneda, no toca la caja real y conserva la categoría. */
export async function createCardCharge(args: {
  cardId: string;
  purchaseDate: ISODate;
  description: string;
  amount: Cents;
  installments: number;
  /** HNL / USD; por defecto la moneda de la entidad. */
  currency?: string | null;
  categoryId?: string | null;
  counterpartyId?: string | null;
  counterpartyName?: string | null;
  userId: string;
  /** Uso interno (bandeja): ejecuta dentro de una transacción existente. */
  tx?: Tx;
}) {
  const run = async (tx: Tx) => {
    const card = await lockCard(tx, args.cardId);
    cardCycleOf(card);
    const base = await entityCurrency(tx, card.entityId);
    const foreign = foreignOf(card, base, args.currency);
    const rate = foreign ? await requireCardRate(card) : null;
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
        currency: foreign,
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
      currency: foreign,
      rateAtTx: rate,
      amountBase: foreign && rate ? convertPair(args.amount, foreign, base, rate) : args.amount,
      categoryId: categoryId ?? null,
      counterpartyId: counterpartyId ?? null,
      movementId: mv.id,
      userId: args.userId,
    });
  };
  return args.tx ? run(args.tx) : prisma.$transaction(run);
}

/**
 * Pago (liquidación) de la tarjeta desde una cuenta líquida de la misma entidad.
 *  - Tramo local: −monto en el banco, +monto en el sub-saldo local.
 *  - Tramo extranjero: −(monto × tasa real) en el banco, +monto en el sub-saldo extranjero, y se
 *    registra el diferencial cambiario contra la tasa de cada consumo.
 * Ambos sub-saldos quedan exactos y el banco baja exactamente lo pagado. NO crea un gasto categorizado.
 */
export async function payCreditCard(args: {
  cardId: string;
  fromAccountId: string;
  /** Monto aplicado al sub-saldo en la moneda de la entidad. (`amount` = alias) */
  amountBase?: Cents;
  amount?: Cents;
  /** Monto abonado al sub-saldo en moneda extranjera. */
  amountForeign?: Cents;
  /** Tasa real aplicada por el banco (por defecto, la vigente de la tarjeta). */
  fxRate?: Rate4 | null;
  date: ISODate;
  note?: string | null;
  userId: string;
}) {
  const amountBase = args.amountBase ?? args.amount ?? 0;
  const amountForeign = args.amountForeign ?? 0;
  if (amountBase < 0 || amountForeign < 0) throw badRequest('Los montos no pueden ser negativos');
  if (amountBase === 0 && amountForeign === 0) throw badRequest('Indica el monto a pagar');

  return prisma.$transaction(async (tx) => {
    const card = await lockCard(tx, args.cardId);
    if (card.type !== 'CREDIT_CARD') throw badRequest('La cuenta destino no es una tarjeta de crédito');
    const from = await tx.account.findUnique({ where: { id: args.fromAccountId } });
    if (!from || from.entityId !== card.entityId) throw badRequest('La cuenta de origen no pertenece a la entidad');
    if (from.type === 'CREDIT_CARD') throw badRequest('Una tarjeta no puede pagarse con otra tarjeta');
    if (from.archivedAt) throw badRequest('La cuenta de origen está archivada');
    const base = await entityCurrency(tx, card.entityId);

    const debtBase = -(await cardBalance(tx, card.id, null));
    const foreign = card.foreignCurrency;
    const debtForeign = foreign ? -(await cardBalance(tx, card.id, foreign)) : 0;
    if (amountForeign > 0 && !foreign) throw badRequest('La tarjeta no es bimoneda');
    if (debtBase <= 0 && debtForeign <= 0) throw conflict('La tarjeta no tiene deuda pendiente');
    if (amountBase > Math.max(debtBase, 0)) throw badRequest(`El pago en ${base} supera la deuda en ${base}`);
    if (amountForeign > Math.max(debtForeign, 0)) throw badRequest(`El abono en ${foreign} supera la deuda en ${foreign}`);

    const label = `Pago Tarjeta: ${card.name}`;
    const date = dbDate(args.date);
    const groupId = randomUUID();
    const result: { paymentIds: string[]; bankTotal: Cents; fxDifference: Cents } = { paymentIds: [], bankTotal: 0, fxDifference: 0 };

    const pendingOf = async (currency: string | null) => {
      const list = await tx.cardInstallment.findMany({
        where: { cardAccountId: card.id, currency },
        include: { charge: { select: { purchaseDate: true, exchangeRateAtTx: true } } },
      });
      return list.map((i) => ({
        id: i.id,
        dueDate: isoOf(i.dueDate),
        number: i.number,
        purchaseDate: isoOf(i.charge.purchaseDate),
        pending: cents(i.amount) - cents(i.settledAmount),
        rateAtTx: i.charge.exchangeRateAtTx ? rate4(i.charge.exchangeRateAtTx) : null,
      }));
    };

    const leg = async (o: { currency: string | null; cardAmount: Cents; bankAmount: Cents; rate: Rate4 | null; desc: string }) => {
      const pending = await pendingOf(o.currency);
      const { allocations } = allocatePayment(pending, o.cardAmount);
      let diff = 0;
      if (o.currency && o.rate) {
        const byId = new Map(pending.map((p) => [p.id, p]));
        diff = fxDifference(
          allocations.map((a) => ({ amount: a.amount, rateAtTx: byId.get(a.installmentId)?.rateAtTx ?? o.rate! })),
          o.bankAmount,
          o.rate,
          o.cardAmount,
          (amount, r) => convertPair(amount, o.currency!, base, r),
        );
      }
      const bankMv = await tx.cashMovement.create({
        data: { entityId: card.entityId, accountId: from.id, type: 'CARD_PAYMENT', amount: dec(-o.bankAmount), date, description: o.desc, createdById: args.userId },
      });
      const cardMv = await tx.cashMovement.create({
        data: {
          entityId: card.entityId,
          accountId: card.id,
          type: 'CARD_PAYMENT',
          amount: dec(o.cardAmount),
          currency: o.currency,
          date,
          description: `${o.desc} (desde ${from.name})`,
          createdById: args.userId,
        },
      });
      const payment = await tx.cardPayment.create({
        data: {
          entityId: card.entityId,
          cardAccountId: card.id,
          fromAccountId: from.id,
          amount: dec(o.cardAmount),
          currency: o.currency,
          bankAmount: dec(o.bankAmount),
          fxRateApplied: o.rate ? rateToString(o.rate) : null,
          fxDifference: dec(diff),
          groupId,
          date,
          bankMovementId: bankMv.id,
          cardMovementId: cardMv.id,
          note: args.note ?? null,
          createdById: args.userId,
        },
      });
      for (const a of allocations) {
        await tx.cardPaymentAllocation.create({ data: { paymentId: payment.id, installmentId: a.installmentId, amount: dec(a.amount) } });
        await tx.cardInstallment.update({ where: { id: a.installmentId }, data: { settledAmount: { increment: dec(a.amount) } } });
      }
      result.paymentIds.push(payment.id);
      result.bankTotal += o.bankAmount;
      result.fxDifference += diff;
    };

    if (amountBase > 0) {
      await leg({ currency: null, cardAmount: amountBase, bankAmount: amountBase, rate: null, desc: label });
    }
    if (amountForeign > 0 && foreign) {
      const rate = args.fxRate ?? (await requireCardRate(card));
      const bankAmount = convertPair(amountForeign, foreign, base, rate);
      await leg({
        currency: foreign,
        cardAmount: amountForeign,
        bankAmount,
        rate,
        desc: `${label} (${foreign} ${(amountForeign / 100).toFixed(2)} @ ${rateToString(rate)})`,
      });
    }

    return {
      ...result,
      remainingDebt: debtBase - amountBase,
      remainingDebtForeign: debtForeign - amountForeign,
    };
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

// ---------------------------------------------------------------- Resumen para la UI
interface Money2 {
  base: Cents;
  foreign: Cents;
}

/** Resumen por tarjeta para la vista "Tarjetas" (sub-saldos por moneda + consolidado en moneda local). */
export async function getCardsSummary(entityIds: string[], today: ISODate) {
  const cards = await prisma.account.findMany({
    where: { entityId: { in: entityIds }, type: 'CREDIT_CARD' },
    include: { entity: { select: { currency: true } } },
    orderBy: [{ archivedAt: 'asc' }, { createdAt: 'asc' }],
  });
  if (cards.length === 0) return [];
  const ids = cards.map((c) => c.id);
  const [balances, installments, payments, fx] = await Promise.all([
    prisma.cashMovement.groupBy({ by: ['accountId', 'currency'], where: { accountId: { in: ids } }, _sum: { amount: true } }),
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
            exchangeRateAtTx: true,
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
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    }),
    getCurrentFx(),
  ]);

  return cards.map((card) => {
    const base = card.entity.currency;
    const foreign = card.foreignCurrency;
    const rate = cardRateFor(card, fx);
    const toBase = (v: Cents): Cents | null => (foreign && rate ? convertPair(v, foreign, base, rate) : foreign ? null : 0);
    const bal = (cur: string | null) =>
      cents(balances.find((b) => b.accountId === card.id && (b.currency ?? null) === cur)?._sum.amount ?? null);
    const debt = Math.max(-bal(null), 0);
    const debtForeign = foreign ? Math.max(-bal(foreign), 0) : 0;
    const debtForeignInBase = toBase(debtForeign);

    const mine = installments.filter((i) => i.cardAccountId === card.id);
    const currentClose = card.statementDay ? statementCloseFor(today, card.statementDay) : null;
    const groups = new Map<string, { dueDate: ISODate; statementDate: ISODate; total: Money2; pending: Money2; items: unknown[] }>();
    const pendingTotal: Money2 = { base: 0, foreign: 0 };
    const currentCycle: Money2 = { base: 0, foreign: 0 };
    for (const i of mine) {
      const isForeign = Boolean(i.currency && i.currency !== base);
      const k: keyof Money2 = isForeign ? 'foreign' : 'base';
      const amount = cents(i.amount);
      const pending = amount - cents(i.settledAmount);
      const dueDate = isoOf(i.dueDate);
      const statementDate = isoOf(i.statementDate);
      pendingTotal[k] += pending;
      if (currentClose && statementDate === currentClose && !i.charge.isOpening) currentCycle[k] += amount;
      const g = groups.get(dueDate) ?? { dueDate, statementDate, total: { base: 0, foreign: 0 }, pending: { base: 0, foreign: 0 }, items: [] };
      g.total[k] += amount;
      g.pending[k] += pending;
      g.items.push({
        installmentId: i.id,
        chargeId: i.chargeId,
        description: i.charge.description,
        categoryName: i.charge.category?.name ?? null,
        counterpartyName: i.charge.counterparty?.name ?? null,
        purchaseDate: isoOf(i.charge.purchaseDate),
        chargeAmount: cents(i.charge.amount),
        currency: isForeign ? i.currency : base,
        rateAtTx: i.charge.exchangeRateAtTx ? rateToString(rate4(i.charge.exchangeRateAtTx)) : null,
        isOpening: i.charge.isOpening,
        fromObligation: Boolean(i.charge.obligationId),
        number: i.number,
        count: i.count,
        amount,
        pending,
      });
      groups.set(dueDate, g);
    }
    const statements = Array.from(groups.values()).map((g) => {
      const pendingAll = g.pending.base + g.pending.foreign;
      const totalAll = g.total.base + g.total.foreign;
      const pendingForeignInBase = toBase(g.pending.foreign);
      return {
        ...g,
        pendingTotalBase: pendingForeignInBase === null ? null : g.pending.base + pendingForeignInBase,
        status: pendingAll === 0 ? 'PAID' : g.dueDate < today ? 'OVERDUE' : pendingAll < totalAll ? 'PARTIAL' : 'OPEN',
      };
    });
    const next = statements.find((s) => s.pending.base + s.pending.foreign > 0) ?? null;
    const limit = card.creditLimit ? cents(card.creditLimit) : null;
    const limitForeign = card.creditLimitForeign ? cents(card.creditLimitForeign) : null;
    const available = limit === null ? null : limit - debt;
    const availableForeign = limitForeign === null ? null : limitForeign - debtForeign;
    const availableForeignInBase = availableForeign === null ? 0 : toBase(availableForeign);

    return {
      id: card.id,
      entityId: card.entityId,
      name: card.name,
      institution: card.institution,
      archived: Boolean(card.archivedAt),
      statementDay: card.statementDay,
      paymentDueDay: card.paymentDueDay,
      defaultPaymentAccountId: card.defaultPaymentAccountId,
      currency: base,
      foreignCurrency: foreign,
      /** Tasa de venta de la tarjeta (propia o global), como string de 4 decimales. */
      sellRate: rate ? rateToString(rate) : null,
      customSellRate: Boolean(card.customSellRate),
      creditLimit: limit,
      creditLimitForeign: limitForeign,
      available,
      availableForeign,
      availableTotalBase: available === null && availableForeign === null ? null : (available ?? 0) + (availableForeignInBase ?? 0),
      debt,
      debtForeign,
      debtForeignInBase,
      /** Total consolidado a pagar en la moneda de la entidad (L. + $ × tasa vigente). */
      totalToPayBase: debtForeignInBase === null ? null : debt + debtForeignInBase,
      pendingInstallments: pendingTotal,
      currentCycle,
      currentStatementDate: currentClose,
      nextPayment: next
        ? { dueDate: next.dueDate, pending: next.pending.base, pendingForeign: next.pending.foreign, totalBase: next.pendingTotalBase }
        : null,
      statements,
      payments: payments
        .filter((p) => p.cardAccountId === card.id)
        .map((p) => ({
          id: p.id,
          groupId: p.groupId,
          date: isoOf(p.date),
          currency: p.currency ?? base,
          amount: cents(p.amount),
          bankAmount: p.bankAmount ? cents(p.bankAmount) : cents(p.amount),
          fxRateApplied: p.fxRateApplied ? rateToString(rate4(p.fxRateApplied)) : null,
          fxDifference: cents(p.fxDifference),
          fromAccountName: p.fromAccount.name,
          note: p.note,
        })),
    };
  });
}
export type CardSummaryDto = Awaited<ReturnType<typeof getCardsSummary>>[number];
