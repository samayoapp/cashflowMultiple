import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { badRequest, conflict, notFound } from './api';
import { cents, dbDate, dec, isoOf } from './serialize';
import { expandRule } from '@/lib/projection/recurrence';
import type { ISODate } from '@/lib/dates';
import { centsToDecimalString, type Cents } from '@/lib/money';
import { insertCardCharge } from './cards';
import { assertOnOrAfterOpening } from './account-opening';
import { editTransferAmounts, repaymentTotals, splitTransferPayment } from '@/lib/projection/loans';
import { assertCategory } from './catalog';

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
export interface RegisterPaymentArgs {
  obligationId: string;
  accountId: string;
  amount: Cents;
  date: ISODate;
  note?: string | null;
  /** Solo si la cuenta es una tarjeta de crédito: número de cuotas (1..36). */
  installments?: number;
  userId: string;
}

export async function registerPayment(args: RegisterPaymentArgs) {
  return prisma.$transaction((tx) => registerPaymentTx(tx, args));
}

/** Igual que registerPayment, dentro de una transacción existente (p. ej. crear y liquidar a la vez). */
export async function registerPaymentTx(tx: Tx, args: RegisterPaymentArgs) {
  {
    const { ob, paid, remaining } = await lockObligation(tx, args.obligationId);
    if (ob.isHypothetical) throw conflict('Una partida hipotética no puede recibir abonos reales');
    if (ob.transferId) throw conflict('Esta partida es una transferencia: usa "Ejecutar transferencia"');
    if (ob.status === 'SETTLED' || ob.status === 'CANCELLED') throw conflict('La partida ya está cerrada');
    if (args.amount > remaining) throw badRequest('El abono supera el saldo pendiente');

    const account = await tx.account.findUnique({ where: { id: args.accountId } });
    if (!account || account.entityId !== ob.entityId) throw badRequest('La cuenta no pertenece a la unidad de negocio');
    if (account.archivedAt) throw badRequest('La cuenta está archivada');
    const isCard = account.type === 'CREDIT_CARD';
    if (isCard && ob.direction === 'IN') throw badRequest('Un cobro no puede registrarse en una tarjeta de crédito');
    await assertOnOrAfterOpening(tx, account, args.date);
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
  }
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
  /** Solo préstamos: programa su devolución (CxC en quien presta, CxP en quien recibe). */
  repayment?: { dueDate: ISODate; interest: Cents } | null;
  /** Reembolso de un gasto pagado con tarjeta de la unidad destino (se paga por abonos). */
  reimbursement?: boolean;
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
  if (args.fromEntityId === args.toEntityId) throw badRequest('Origen y destino deben ser unidades de negocio distintas');
  const [from, to] = await Promise.all([
    tx.entity.findUnique({ where: { id: args.fromEntityId } }),
    tx.entity.findUnique({ where: { id: args.toEntityId } }),
  ]);
  if (!from || !to) throw notFound('Unidad de negocio no encontrada');

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
      isReimbursement: Boolean(args.reimbursement),
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
  if (args.repayment) {
    if (args.kind !== 'LOAN') throw badRequest('Solo los préstamos tienen devolución');
    await createLoanRepaymentTx(tx, t.id, { ...args.repayment, userId: args.userId });
  }
  return t;
}

/**
 * Programa la devolución de un préstamo entre unidades: una transferencia en sentido contrario
 * (quien recibió → quien prestó) por capital + interés, que se paga con abonos hasta cerrarse.
 * Queda como CxP en quien recibió y CxC en quien prestó (en el consolidado se netea).
 */
export async function createLoanRepaymentTx(
  tx: Tx,
  loanId: string,
  args: { dueDate: ISODate; interest: Cents; userId: string },
) {
  const loan = await tx.interEntityTransfer.findUnique({
    where: { id: loanId },
    include: { repayment: { select: { id: true } }, fromEntity: true, toEntity: true },
  });
  if (!loan) throw notFound('Préstamo no encontrado');
  if (loan.kind !== 'LOAN') throw badRequest('Solo los préstamos tienen devolución');
  if (loan.repaymentOfId) throw badRequest('Esta transferencia ya es una devolución');
  if (loan.status === 'CANCELLED') throw conflict('El préstamo está cancelado');
  if (loan.repayment) throw conflict('Este préstamo ya tiene su devolución programada');
  if (args.interest < 0) throw badRequest('El interés no puede ser negativo');
  const lentOn = isoOf(loan.executedDate ?? loan.expectedDate);
  if (args.dueDate < lentOn) throw badRequest(`La devolución no puede ser antes del préstamo (${lentOn})`);

  const lender = loan.fromEntity;
  const borrower = loan.toEntity;
  const principalLender = cents(loan.amountFrom);
  // El interés se pacta en la moneda de quien presta; del lado de quien recibió se convierte a la tasa del préstamo
  const { lender: totalLender, borrower: totalBorrower } = repaymentTotals(principalLender, cents(loan.amountTo), args.interest);
  const notes = args.interest > 0 ? `Capital ${centsToDecimalString(principalLender)} + interés ${centsToDecimalString(args.interest)} (${lender.currency})` : null;

  const r = await tx.interEntityTransfer.create({
    data: {
      kind: 'LOAN',
      fromEntityId: borrower.id,
      toEntityId: lender.id,
      amountFrom: dec(totalBorrower),
      amountTo: dec(totalLender),
      expectedDate: dbDate(args.dueDate),
      description: loan.description ? `Devolución: ${loan.description}` : 'Devolución de préstamo',
      repaymentOfId: loan.id,
      interestAmount: dec(args.interest),
      createdById: args.userId,
    },
  });
  await tx.obligation.createMany({
    data: [
      {
        entityId: borrower.id,
        direction: 'OUT',
        description: `Devolución préstamo → ${lender.name}`,
        amount: dec(totalBorrower),
        dueDate: dbDate(args.dueDate),
        expectedDate: dbDate(args.dueDate),
        priority: 'FLEXIBLE',
        transferId: r.id,
        notes,
        createdById: args.userId,
      },
      {
        entityId: lender.id,
        direction: 'IN',
        description: `Devolución préstamo ← ${borrower.name}`,
        amount: dec(totalLender),
        dueDate: dbDate(args.dueDate),
        expectedDate: dbDate(args.dueDate),
        priority: 'FLEXIBLE',
        transferId: r.id,
        notes,
        createdById: args.userId,
      },
    ],
  });
  return r;
}

/**
 * Ejecuta una transferencia entre unidades: mueve caja real en ambas y abona sus partidas espejo.
 * Sin montos se liquida el saldo pendiente completo. Con `amountFrom` se registra un ABONO
 * (solo en devoluciones de préstamo); la transferencia se cierra cuando ambos lados quedan saldados.
 */
export async function payTransfer(args: {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  date: ISODate;
  /** Abono: lo que sale de la unidad origen (su moneda). */
  amountFrom?: Cents;
  /** Abono con monedas distintas: lo que entra al destino. Por defecto, proporcional. */
  amountTo?: Cents;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "InterEntityTransfer" WHERE id = ${args.transferId} FOR UPDATE`;
    const t = await tx.interEntityTransfer.findUnique({
      where: { id: args.transferId },
      include: { repaymentOf: { select: { status: true } } },
    });
    if (!t) throw notFound('Transferencia no encontrada');
    if (t.status !== 'PLANNED') throw conflict('La transferencia ya fue ejecutada o cancelada');
    if (t.repaymentOf && t.repaymentOf.status !== 'EXECUTED') {
      throw conflict('El préstamo todavía no se ha entregado: ejecútalo primero');
    }
    const partial = args.amountFrom !== undefined;
    if (partial && !t.repaymentOfId && !t.isReimbursement) {
      throw badRequest('Solo las devoluciones de préstamo y los reembolsos aceptan abonos');
    }

    const [fromAcc, toAcc] = await Promise.all([
      tx.account.findUnique({ where: { id: args.fromAccountId } }),
      tx.account.findUnique({ where: { id: args.toAccountId } }),
    ]);
    if (!fromAcc || fromAcc.entityId !== t.fromEntityId) throw badRequest('Cuenta de origen inválida');
    if (!toAcc || toAcc.entityId !== t.toEntityId) throw badRequest('Cuenta de destino inválida');
    if (fromAcc.type === 'CREDIT_CARD' || toAcc.type === 'CREDIT_CARD') {
      throw badRequest('Las transferencias entre entidades usan cuentas líquidas, no tarjetas');
    }
    if (fromAcc.archivedAt || toAcc.archivedAt) throw badRequest('No se puede usar una cuenta archivada');
    await assertOnOrAfterOpening(tx, fromAcc, args.date);
    await assertOnOrAfterOpening(tx, toAcc, args.date);

    const obligations = await tx.obligation.findMany({
      where: { transferId: t.id },
      include: { payments: { select: { amount: true } } },
    });
    const out = obligations.find((o) => o.direction === 'OUT');
    const inn = obligations.find((o) => o.direction === 'IN');
    if (!out || !inn) throw conflict('La transferencia no tiene sus dos partidas');
    const remainingOf = (o: typeof out) => cents(o.amount) - o.payments.reduce((sum, p) => sum + cents(p.amount), 0);
    const remOut = remainingOf(out);
    const remIn = remainingOf(inn);

    let split: ReturnType<typeof splitTransferPayment>;
    try {
      split = splitTransferPayment(remOut, remIn, args.amountFrom, args.amountTo);
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : 'Abono inválido');
    }
    const { out: payOut, in: payIn, closes: closed } = split;

    const date = dbDate(args.date);
    for (const [ob, account, amount] of [
      [out, fromAcc, payOut],
      [inn, toAcc, payIn],
    ] as const) {
      const mv = await tx.cashMovement.create({
        data: {
          entityId: ob.entityId,
          accountId: account.id,
          type: 'TRANSFER',
          amount: dec(ob.direction === 'OUT' ? -amount : amount),
          date,
          description: partial ? `Abono: ${ob.description}` : ob.description,
          transferId: t.id,
          createdById: args.userId,
        },
      });
      await tx.payment.create({
        data: { obligationId: ob.id, accountId: account.id, amount: dec(amount), date, cashMovementId: mv.id, createdById: args.userId },
      });
    }
    await tx.obligation.updateMany({ where: { transferId: t.id }, data: { status: closed ? 'SETTLED' : 'PARTIAL' } });

    return tx.interEntityTransfer.update({
      where: { id: t.id },
      data: closed
        ? { status: 'EXECUTED', executedDate: date, fromAccountId: fromAcc.id, toAccountId: toAcc.id }
        : { fromAccountId: fromAcc.id, toAccountId: toAcc.id },
    });
  });
}

/** Partidas espejo de una transferencia con sus abonos (para editar o eliminar). */
async function loadInterUnitForEdit(tx: Tx, transferId: string) {
  await tx.$queryRaw`SELECT id FROM "InterEntityTransfer" WHERE id = ${transferId} FOR UPDATE`;
  const t = await tx.interEntityTransfer.findUnique({
    where: { id: transferId },
    include: {
      fromEntity: true,
      toEntity: true,
      reimbursedCharge: { select: { id: true } },
      obligations: { include: { payments: { select: { amount: true } } } },
    },
  });
  if (!t) throw notFound('Transferencia no encontrada');
  if (!t.isReimbursement && !t.repaymentOfId) {
    throw badRequest('Solo se editan reembolsos y devoluciones de préstamo entre unidades');
  }
  const out = t.obligations.find((o) => o.direction === 'OUT');
  const inn = t.obligations.find((o) => o.direction === 'IN');
  if (!out || !inn) throw conflict('La transferencia no tiene sus dos partidas');
  const paidOf = (o: typeof out) => o.payments.reduce((s, p) => s + cents(p.amount), 0);
  return { t, out, inn, paidFrom: paidOf(out), paidTo: paidOf(inn) };
}

/**
 * Edita un reembolso o una devolución de préstamo entre unidades: cambia SIEMPRE las dos partidas
 * espejo juntas (CxP en el origen y CxC en el destino). No mueve caja.
 * Monto y categoría solo aplican a reembolsos (la devolución de un préstamo la define el préstamo).
 */
export async function updateInterUnitTransfer(args: {
  transferId: string;
  /** Detalle (en reembolsos, sin el prefijo "Reembolso: "). */
  description?: string;
  notes?: string | null;
  categoryId?: string | null;
  amountFrom?: Cents;
  amountTo?: Cents;
  date?: ISODate;
}) {
  return prisma.$transaction(async (tx) => {
    const { t, out, inn, paidFrom, paidTo } = await loadInterUnitForEdit(tx, args.transferId);
    if (t.status !== 'PLANNED') throw conflict('Solo se edita lo que está pendiente (no saldado ni cancelado)');
    const isReimb = t.isReimbursement;

    const transferData: Prisma.InterEntityTransferUpdateInput = {};
    const outData: Prisma.ObligationUpdateInput = {};
    const inData: Prisma.ObligationUpdateInput = {};

    if (args.description !== undefined) {
      const detail = args.description.trim().replace(/^Reembolso:\s*/i, '');
      if (!detail) throw badRequest('La descripción no puede quedar vacía');
      const label = isReimb ? `Reembolso: ${detail}` : detail;
      transferData.description = label;
      outData.description = `${label} → ${t.toEntity.name}`;
      inData.description = `${label} ← ${t.fromEntity.name}`;
    }
    if (args.notes !== undefined) {
      const notes = args.notes?.trim() || null;
      outData.notes = notes;
      inData.notes = notes;
    }
    if (args.categoryId !== undefined) {
      if (!isReimb) throw badRequest('Las devoluciones de préstamo no llevan categoría');
      const categoryId = await assertCategory(tx, t.fromEntityId, args.categoryId);
      outData.category = categoryId ? { connect: { id: categoryId } } : { disconnect: true };
    }
    if (args.amountFrom !== undefined) {
      const oldFrom = cents(t.amountFrom);
      const oldTo = cents(t.amountTo);
      const changes = args.amountFrom !== oldFrom || (args.amountTo !== undefined && args.amountTo !== oldTo);
      if (changes) {
        if (!isReimb) throw badRequest('El monto de una devolución lo define el préstamo y su interés');
        if (t.reimbursedCharge) {
          throw conflict('Este reembolso está ligado a un consumo de tarjeta: su monto lo define ese consumo');
        }
        let amounts: { from: Cents; to: Cents };
        try {
          amounts = editTransferAmounts({
            oldFrom,
            oldTo,
            paidFrom,
            paidTo,
            newFrom: args.amountFrom,
            newTo: args.amountTo,
            sameCurrency: t.fromEntity.currency === t.toEntity.currency,
          });
        } catch (e) {
          throw badRequest(e instanceof Error ? e.message : 'Monto inválido');
        }
        transferData.amountFrom = dec(amounts.from);
        transferData.amountTo = dec(amounts.to);
        outData.amount = dec(amounts.from);
        inData.amount = dec(amounts.to);
        outData.status = paidFrom > 0 ? 'PARTIAL' : 'OPEN';
        inData.status = paidTo > 0 ? 'PARTIAL' : 'OPEN';
      }
    }
    if (args.date !== undefined) {
      if (t.repaymentOfId) {
        const loan = await tx.interEntityTransfer.findUnique({ where: { id: t.repaymentOfId } });
        const lentOn = loan ? isoOf(loan.executedDate ?? loan.expectedDate) : null;
        if (lentOn && args.date < lentOn) throw badRequest(`La devolución no puede ser antes del préstamo (${lentOn})`);
      }
      const d = dbDate(args.date);
      transferData.expectedDate = d;
      for (const data of [outData, inData]) {
        data.dueDate = d;
        data.expectedDate = d;
      }
    }

    await tx.interEntityTransfer.update({ where: { id: t.id }, data: transferData });
    await tx.obligation.update({ where: { id: out.id }, data: outData });
    await tx.obligation.update({ where: { id: inn.id }, data: inData });
    return { id: t.id };
  });
}

/**
 * Elimina por completo un reembolso o una devolución de préstamo entre unidades (p. ej. registrado
 * por error), con sus dos partidas. Solo si no tiene abonos en ningún lado; si los tiene, se cancela
 * el saldo pendiente. Una devolución eliminada deja el préstamo "sin devolución programada".
 */
export async function deleteInterUnitTransfer(transferId: string) {
  return prisma.$transaction(async (tx) => {
    const { t, paidFrom, paidTo } = await loadInterUnitForEdit(tx, transferId);
    if (paidFrom > 0 || paidTo > 0 || t.status === 'EXECUTED') {
      throw conflict('Tiene abonos registrados: no se puede eliminar; cancela el saldo pendiente en su lugar');
    }
    if (t.reimbursedCharge) {
      throw conflict('Está ligado a un consumo de tarjeta: cancélalo en su lugar (el consumo podrá asignarse de nuevo)');
    }
    // Las partidas espejo se borran en cascada
    await tx.interEntityTransfer.delete({ where: { id: t.id } });
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
    await assertOnOrAfterOpening(tx, fromAcc, args.date);
    await assertOnOrAfterOpening(tx, toAcc, args.date);

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
    await assertOnOrAfterOpening(tx, account, args.date);
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

/**
 * Elimina una partida sin abonos. Las transferencias se manejan desde su pantalla, y una ocurrencia
 * de recurrencia activa se omite (cancela): si se borrara, la proyección la volvería a generar.
 */
export async function deleteObligation(id: string) {
  return prisma.$transaction(async (tx) => {
    const { ob, paid } = await lockObligation(tx, id);
    if (ob.transferId) throw conflict('Es una transferencia entre entidades: anúlala desde Transferencias');
    if (paid > 0 || ob.payments.length > 0) {
      throw conflict('Tiene cobros/pagos registrados: deshazlos primero (botón Editar, en la lista de cobros/pagos registrados) y luego elimínala');
    }
    if (await tx.cardCharge.findUnique({ where: { obligationId: ob.id } })) {
      throw conflict('Fue pagada con tarjeta: deshaz ese consumo antes de eliminarla');
    }
    if (ob.recurrenceId) {
      const rule = await tx.recurringRule.findUnique({ where: { id: ob.recurrenceId }, select: { active: true } });
      if (rule?.active) {
        throw conflict('Es una fecha de una recurrencia: usa "Omitir" para quitar solo esta fecha, o elimina la recurrencia completa');
      }
    }
    await tx.obligation.delete({ where: { id: ob.id } });
  });
}

/** Deshace un cobro/pago: borra el abono y su movimiento de caja, y recalcula el estado de la partida. */
export async function deletePayment(obligationId: string, paymentId: string) {
  return prisma.$transaction(async (tx) => {
    const { ob } = await lockObligation(tx, obligationId);
    const p = await tx.payment.findUnique({ where: { id: paymentId }, include: { account: { select: { type: true } } } });
    if (!p || p.obligationId !== ob.id) throw notFound('Abono no encontrado');
    if (ob.transferId) throw conflict('Es una transferencia entre entidades: anúlala desde Transferencias');
    if (p.account.type === 'CREDIT_CARD') {
      throw conflict('Este pago se hizo con tarjeta (generó cuotas): no se puede deshacer desde aquí');
    }
    await tx.payment.delete({ where: { id: p.id } });
    await tx.cashMovement.delete({ where: { id: p.cashMovementId } });
    const agg = await tx.payment.aggregate({ where: { obligationId: ob.id }, _sum: { amount: true } });
    const paid = cents(agg._sum.amount);
    const status = ob.status === 'CANCELLED' ? 'CANCELLED' : paid === 0 ? 'OPEN' : paid >= cents(ob.amount) ? 'SETTLED' : 'PARTIAL';
    await tx.obligation.update({ where: { id: ob.id }, data: { status } });
  });
}

/**
 * Elimina una recurrencia: borra sus ocurrencias sin abonos y conserva (como partidas puntuales)
 * las que ya tienen cobros/pagos o un consumo de tarjeta.
 */
export async function deleteRecurrence(ruleId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "RecurringRule" WHERE id = ${ruleId} FOR UPDATE`;
    const occ = await tx.obligation.findMany({
      where: { recurrenceId: ruleId },
      select: { id: true, _count: { select: { payments: true } }, cardCharge: { select: { id: true } } },
    });
    const keep = occ.filter((o) => o._count.payments > 0 || o.cardCharge).map((o) => o.id);
    const drop = occ.filter((o) => !keep.includes(o.id)).map((o) => o.id);
    if (drop.length) await tx.obligation.deleteMany({ where: { id: { in: drop } } });
    if (keep.length) await tx.obligation.updateMany({ where: { id: { in: keep } }, data: { recurrenceId: null, occurrenceDate: null } });
    await tx.recurringRule.delete({ where: { id: ruleId } });
    return { deleted: drop.length, kept: keep.length };
  });
}
