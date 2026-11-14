import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { badRequest, conflict, notFound } from './api';
import { cents, dbDate, dec, isoOf } from './serialize';
import { expandRule } from '@/lib/projection/recurrence';
import type { ISODate } from '@/lib/dates';
import type { Cents } from '@/lib/money';
import { insertCardCharge } from './cards';

type Tx = Prisma.TransactionClient;

async function lockObligation(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "Obligation" WHERE id = ${id} FOR UPDATE`;
  const ob = await tx.obligation.findUnique({ where: { id }, include: { payments: { select: { amount: true } } } });
  if (!ob) throw notFound('Partida no encontrada');
  const paid = ob.payments.reduce((s, p) => s + cents(p.amount), 0);
  return { ob, paid, remaining: cents(ob.amount) - paid };
}

/**
 * Registra un abono (parcial o total). En una sola transacción:
 * crea el movimiento real de caja, el abono y actualiza el estado.
 */
export async function registerPayment(args: {
  obligationId: string;
  accountId: string;
  amount: Cents;
  date: ISODate;
  note?: string | null;
  /** Solo si la cuenta es una tarjeta de crédito: número de cuotas (1..36). */
  installments?: number;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const { ob, paid, remaining } = await lockObligation(tx, args.obligationId);
    if (ob.isHypothetical) throw conflict('Una partida hipotética no puede recibir abonos reales');
    if (ob.transferId) throw conflict('Esta partida es una transferencia: usa "Ejecutar transferencia"');
    if (ob.status === 'SETTLED' || ob.status === 'CANCELLED') throw conflict('La partida ya está cerrada');
    if (args.amount > remaining) throw badRequest('El abono supera el saldo pendiente');

    const account = await tx.account.findUnique({ where: { id: args.accountId } });
    if (!account || account.entityId !== ob.entityId) throw badRequest('La cuenta no pertenece a la entidad');
    if (account.archivedAt) throw badRequest('La cuenta está archivada');
    const isCard = account.type === 'CREDIT_CARD';
    if (isCard && ob.direction === 'IN') throw badRequest('Un cobro no puede registrarse en una tarjeta de crédito');
    if (isCard) {
      // Un consumo con tarjeta liquida la CxP completa: la deuda pasa a la tarjeta
      if (args.amount !== remaining) throw badRequest('Con tarjeta se paga el saldo pendiente completo');
      if (await tx.cardCharge.findUnique({ where: { obligationId: ob.id } })) {
        throw conflict('Esta partida ya fue pagada con tarjeta');
      }
    }

    const signed = ob.direction === 'IN' ? args.amount : -args.amount;
    const movement = await tx.cashMovement.create({
      data: {
        entityId: ob.entityId,
        accountId: account.id,
        type: 'PAYMENT',
        amount: dec(signed),
        date: dbDate(args.date),
        description: `${isCard ? 'Consumo' : ob.direction === 'IN' ? 'Cobro' : 'Pago'}: ${ob.description}`,
        createdById: args.userId,
      },
    });
    if (isCard) {
      // La categoría vive en la CxP; el consumo no la repite para no duplicar el gasto
      await insertCardCharge(tx, {
        card: account,
        purchaseDate: args.date,
        description: ob.description,
        amount: args.amount,
        installments: args.installments ?? 1,
        counterpartyId: ob.counterpartyId,
        obligationId: ob.id,
        movementId: movement.id,
        userId: args.userId,
      });
    }
    const payment = await tx.payment.create({
      data: {
        obligationId: ob.id,
        accountId: account.id,
        amount: dec(args.amount),
        date: dbDate(args.date),
        cashMovementId: movement.id,
        note: args.note ?? null,
        createdById: args.userId,
      },
    });
    const newRemaining = remaining - args.amount;
    await tx.obligation.update({
      where: { id: ob.id },
      data: { status: newRemaining === 0 ? 'SETTLED' : paid + args.amount > 0 ? 'PARTIAL' : 'OPEN' },
    });
    return { payment, remaining: newRemaining };
  });
}

/**
 * Crea (o devuelve) la Obligation concreta de una ocurrencia recurrente,
 * para poder pagarla, moverla o editarla.
 */
export async function materializeOccurrence(ruleId: string, date: ISODate, userId: string) {
  const rule = await prisma.recurringRule.findUnique({ where: { id: ruleId } });
  if (!rule) throw notFound('Recurrencia no encontrada');
  const valid = expandRule(
    {
      id: rule.id,
      entityId: rule.entityId,
      direction: rule.direction,
      description: rule.description,
      amount: cents(rule.amount),
      frequency: rule.frequency,
      startDate: isoOf(rule.startDate),
      endDate: rule.endDate ? isoOf(rule.endDate) : null,
      priority: rule.priority,
      active: true,
    },
    date,
    date,
  );
  if (valid.length === 0) throw badRequest('La fecha no corresponde a una ocurrencia de la recurrencia');

  const existing = await prisma.obligation.findUnique({
    where: { recurrenceId_occurrenceDate: { recurrenceId: rule.id, occurrenceDate: dbDate(date) } },
  });
  if (existing) return existing;

  try {
    return await prisma.obligation.create({
      data: {
        entityId: rule.entityId,
        direction: rule.direction,
        description: rule.description,
        amount: rule.amount,
        dueDate: dbDate(date),
        expectedDate: dbDate(date),
        priority: rule.priority,
        counterpartyId: rule.counterpartyId,
        categoryId: rule.categoryId,
        recurrenceId: rule.id,
        occurrenceDate: dbDate(date),
        createdById: userId,
      },
    });
  } catch (e) {
    // Carrera: otra petición la creó primero
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return prisma.obligation.findUniqueOrThrow({
        where: { recurrenceId_occurrenceDate: { recurrenceId: rule.id, occurrenceDate: dbDate(date) } },
      });
    }
    throw e;
  }
}

interface TransferArgs {
  kind: 'LOAN' | 'CONTRIBUTION' | 'TRANSFER';
  fromEntityId: string;
  toEntityId: string;
  amountFrom: Cents;
  amountTo: Cents;
  expectedDate: ISODate;
  description: string | null;
  userId: string;
  /** Categoría de la partida de salida (p. ej. gasto reembolsado a otra entidad). */
  outCategoryId?: string | null;
}

/**
 * Crea una transferencia inter-entidad PLANIFICADA: dos partidas espejo
 * (salida en origen, entrada en destino) con el mismo transferId.
 */
export async function createTransfer(args: TransferArgs) {
  return prisma.$transaction((tx) => createTransferTx(tx, args));
}

/** Igual que createTransfer, dentro de una transacción existente. */
export async function createTransferTx(tx: Tx, args: TransferArgs) {
  if (args.fromEntityId === args.toEntityId) throw badRequest('Origen y destino deben ser entidades distintas');
  const [from, to] = await Promise.all([
    tx.entity.findUnique({ where: { id: args.fromEntityId } }),
    tx.entity.findUnique({ where: { id: args.toEntityId } }),
  ]);
  if (!from || !to) throw notFound('Entidad no encontrada');

  const label =
    args.description ||
    `${args.kind === 'LOAN' ? 'Préstamo' : args.kind === 'CONTRIBUTION' ? 'Aporte' : 'Transferencia'}`;

  const t = await tx.interEntityTransfer.create({
    data: {
      kind: args.kind,
      fromEntityId: from.id,
      toEntityId: to.id,
      amountFrom: dec(args.amountFrom),
      amountTo: dec(args.amountTo),
      expectedDate: dbDate(args.expectedDate),
      description: args.description,
      createdById: args.userId,
    },
  });
  await tx.obligation.createMany({
    data: [
      {
        entityId: from.id,
        direction: 'OUT',
        description: `${label} → ${to.name}`,
        amount: dec(args.amountFrom),
        dueDate: dbDate(args.expectedDate),
        expectedDate: dbDate(args.expectedDate),
        priority: 'FLEXIBLE',
        transferId: t.id,
        categoryId: args.outCategoryId ?? null,
        createdById: args.userId,
      },
      {
        entityId: to.id,
        direction: 'IN',
        description: `${label} ← ${from.name}`,
        amount: dec(args.amountTo),
        dueDate: dbDate(args.expectedDate),
        expectedDate: dbDate(args.expectedDate),
        priority: 'FLEXIBLE',
        transferId: t.id,
        createdById: args.userId,
      },
    ],
  });
  return t;
}

/** Ejecuta una transferencia: mueve caja real en ambas entidades y cierra sus partidas. */
export async function executeTransfer(args: {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  date: ISODate;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "InterEntityTransfer" WHERE id = ${args.transferId} FOR UPDATE`;
    const t = await tx.interEntityTransfer.findUnique({ where: { id: args.transferId } });
    if (!t) throw notFound('Transferencia no encontrada');
    if (t.status !== 'PLANNED') throw conflict('La transferencia ya fue ejecutada o cancelada');

    const [fromAcc, toAcc] = await Promise.all([
      tx.account.findUnique({ where: { id: args.fromAccountId } }),
      tx.account.findUnique({ where: { id: args.toAccountId } }),
    ]);
    if (!fromAcc || fromAcc.entityId !== t.fromEntityId) throw badRequest('Cuenta de origen inválida');
    if (!toAcc || toAcc.entityId !== t.toEntityId) throw badRequest('Cuenta de destino inválida');
    if (fromAcc.type === 'CREDIT_CARD' || toAcc.type === 'CREDIT_CARD') {
      throw badRequest('Las transferencias entre entidades usan cuentas líquidas, no tarjetas');
    }

    const obligations = await tx.obligation.findMany({ where: { transferId: t.id } });
    const date = dbDate(args.date);

    for (const ob of obligations) {
      const isOut = ob.direction === 'OUT';
      const account = isOut ? fromAcc : toAcc;
      const amount = isOut ? cents(t.amountFrom) : cents(t.amountTo);
      const mv = await tx.cashMovement.create({
        data: {
          entityId: ob.entityId,
          accountId: account.id,
          type: 'TRANSFER',
          amount: dec(isOut ? -amount : amount),
          date,
          description: ob.description,
          transferId: t.id,
          createdById: args.userId,
        },
      });
      await tx.payment.create({
        data: {
          obligationId: ob.id,
          accountId: account.id,
          amount: dec(amount),
          date,
          cashMovementId: mv.id,
          createdById: args.userId,
        },
      });
      await tx.obligation.update({ where: { id: ob.id }, data: { status: 'SETTLED' } });
    }

    return tx.interEntityTransfer.update({
      where: { id: t.id },
      data: { status: 'EXECUTED', executedDate: date, fromAccountId: fromAcc.id, toAccountId: toAcc.id },
    });
  });
}

/**
 * Transferencia entre cuentas líquidas de UNA misma entidad (p. ej. banco → caja chica).
 * No cambia la caja de la entidad, así que no genera partidas proyectadas: se ejecuta
 * al momento con dos movimientos espejo (TRANSFER) ligados al mismo AccountTransfer.
 */
export async function createInternalTransfer(args: {
  entityId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: Cents;
  date: ISODate;
  description: string | null;
  userId: string;
}) {
  if (args.fromAccountId === args.toAccountId) throw badRequest('Origen y destino deben ser cuentas distintas');
  return prisma.$transaction(async (tx) => {
    const [fromAcc, toAcc] = await Promise.all([
      tx.account.findUnique({ where: { id: args.fromAccountId } }),
      tx.account.findUnique({ where: { id: args.toAccountId } }),
    ]);
    if (!fromAcc || fromAcc.entityId !== args.entityId) throw badRequest('Cuenta de origen inválida');
    if (!toAcc || toAcc.entityId !== args.entityId) throw badRequest('Cuenta de destino inválida');
    if (fromAcc.archivedAt || toAcc.archivedAt) throw badRequest('No se puede usar una cuenta archivada');
    if (fromAcc.type === 'CREDIT_CARD' || toAcc.type === 'CREDIT_CARD') {
      throw badRequest('Para pagar una tarjeta usa Operaciones → Tarjetas → Pagar');
    }

    const date = dbDate(args.date);
    const label = args.description || 'Transferencia interna';
    const t = await tx.accountTransfer.create({
      data: {
        entityId: args.entityId,
        fromAccountId: fromAcc.id,
        toAccountId: toAcc.id,
        amount: dec(args.amount),
        date,
        description: args.description,
        createdById: args.userId,
      },
    });
    await tx.cashMovement.createMany({
      data: [
        {
          entityId: args.entityId,
          accountId: fromAcc.id,
          type: 'TRANSFER',
          amount: dec(-args.amount),
          date,
          description: `${label} → ${toAcc.name}`,
          accountTransferId: t.id,
          createdById: args.userId,
        },
        {
          entityId: args.entityId,
          accountId: toAcc.id,
          type: 'TRANSFER',
          amount: dec(args.amount),
          date,
          description: `${label} ← ${fromAcc.name}`,
          accountTransferId: t.id,
          createdById: args.userId,
        },
      ],
    });
    return t;
  });
}

/** Anula una transferencia interna: borra sus dos movimientos y la marca cancelada (queda en la bitácora). */
export async function voidInternalTransfer(id: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "AccountTransfer" WHERE id = ${id} FOR UPDATE`;
    const t = await tx.accountTransfer.findUnique({ where: { id } });
    if (!t) throw notFound('Transferencia no encontrada');
    if (t.status !== 'EXECUTED') throw conflict('La transferencia ya está anulada');
    await tx.cashMovement.deleteMany({ where: { accountTransferId: t.id, type: 'TRANSFER' } });
    return tx.accountTransfer.update({ where: { id: t.id }, data: { status: 'CANCELLED' } });
  });
}

/** Conciliación rápida: ajusta el saldo real de una cuenta al saldo del banco. */
export async function reconcileAccount(args: {
  accountId: string;
  actualBalance: Cents;
  date: ISODate;
  userId: string;
  /** Solo tarjetas bimoneda: sub-saldo a conciliar (null = moneda de la entidad). */
  currency?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${args.accountId} FOR UPDATE`;
    const account = await tx.account.findUnique({ where: { id: args.accountId } });
    if (!account) throw notFound('Cuenta no encontrada');
    const entity = await tx.entity.findUniqueOrThrow({ where: { id: account.entityId }, select: { currency: true } });
    const currency = args.currency && args.currency !== entity.currency ? args.currency : null;
    if (currency && account.foreignCurrency !== currency) throw badRequest('La cuenta no maneja esa moneda');
    const agg = await tx.cashMovement.aggregate({ where: { accountId: account.id, currency }, _sum: { amount: true } });
    const current = cents(agg._sum.amount);
    const diff = args.actualBalance - current;
    if (diff === 0) return { adjusted: false, difference: 0 };
    await tx.cashMovement.create({
      data: {
        entityId: account.entityId,
        accountId: account.id,
        type: 'ADJUSTMENT',
        amount: dec(diff),
        currency,
        date: dbDate(args.date),
        description: `Ajuste por conciliación${currency ? ` (${currency})` : ''}`,
        createdById: args.userId,
      },
    });
    return { adjusted: true, difference: diff };
  });
}
