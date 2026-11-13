import type { Account, Prisma } from '@prisma/client';
import { badRequest, conflict } from './api';
import { cents, dbDate, dec, isoOf } from './serialize';
import { cardCycleOf, createOpeningDebt } from './cards';
import { cardRateFor, getCurrentFx } from './fx';
import { installmentDates } from '@/lib/projection/card-cycle';
import { convertPair, rate4 } from '@/lib/projection/fx';
import type { ISODate } from '@/lib/dates';
import type { Cents } from '@/lib/money';

type Tx = Prisma.TransactionClient;

/**
 * Saldo inicial de una cuenta en una moneda (null = moneda de la entidad).
 * En cuentas líquidas `amount` es el saldo con signo; en tarjetas es la deuda (positiva).
 * `locked`: la deuda inicial de la tarjeta ya recibió pagos y solo se corrige conciliando.
 */
export interface OpeningSlot {
  currency: string | null;
  amount: Cents;
  date: ISODate | null;
  locked: boolean;
}

export async function getOpeningSlots(tx: Tx, account: Account): Promise<OpeningSlot[]> {
  if (account.type !== 'CREDIT_CARD') {
    const mv = await tx.cashMovement.findFirst({
      where: { accountId: account.id, type: 'OPENING', currency: null },
      orderBy: { createdAt: 'asc' },
    });
    return [{ currency: null, amount: mv ? cents(mv.amount) : 0, date: mv ? isoOf(mv.date) : null, locked: false }];
  }
  const currencies: (string | null)[] = [null, ...(account.foreignCurrency ? [account.foreignCurrency] : [])];
  const charges = await tx.cardCharge.findMany({
    where: { cardAccountId: account.id, isOpening: true },
    include: { installmentRows: { include: { _count: { select: { allocations: true } } } } },
  });
  return currencies.map((currency) => {
    const c = charges.find((x) => (x.currency ?? null) === currency);
    if (!c) return { currency, amount: 0, date: null, locked: false };
    const locked = c.installmentRows.some((i) => cents(i.settledAmount) > 0 || i._count.allocations > 0);
    return { currency, amount: cents(c.amount), date: isoOf(c.purchaseDate), locked };
  });
}

/** Corrige el saldo de apertura de una cuenta líquida (el movimiento OPENING). */
async function setLiquidOpening(tx: Tx, account: Account, amount: Cents, date: ISODate, userId: string) {
  const mv = await tx.cashMovement.findFirst({
    where: { accountId: account.id, type: 'OPENING', currency: null },
    orderBy: { createdAt: 'asc' },
  });
  if (mv) {
    await tx.cashMovement.update({ where: { id: mv.id }, data: { amount: dec(amount), date: dbDate(date) } });
  } else if (amount !== 0) {
    await tx.cashMovement.create({
      data: {
        entityId: account.entityId,
        accountId: account.id,
        type: 'OPENING',
        amount: dec(amount),
        date: dbDate(date),
        description: 'Saldo de apertura',
        createdById: userId,
      },
    });
  }
}

/**
 * Corrige la deuda inicial de una tarjeta en una moneda. Solo se permite mientras no tenga pagos aplicados:
 * actualiza el movimiento, el consumo y su cuota (fecha de pago incluida); en 0 la elimina.
 */
async function setCardOpening(tx: Tx, card: Account, currency: string | null, debt: Cents, date: ISODate, userId: string) {
  if (debt < 0) throw badRequest('La deuda inicial no puede ser negativa');
  const cycle = cardCycleOf(card);
  const charge = await tx.cardCharge.findFirst({
    where: { cardAccountId: card.id, isOpening: true, currency },
    include: { installmentRows: { include: { _count: { select: { allocations: true } } } } },
  });
  if (!charge) {
    if (debt === 0) return;
    let rateAtTx = null;
    if (currency) {
      rateAtTx = cardRateFor(card, await getCurrentFx());
      if (!rateAtTx) throw badRequest('No hay tipo de cambio registrado para valuar la deuda en moneda extranjera');
    }
    await createOpeningDebt(tx, card, debt, date, userId, { currency, rateAtTx });
    return;
  }
  if (charge.installmentRows.some((i) => cents(i.settledAmount) > 0 || i._count.allocations > 0)) {
    throw conflict(
      `La deuda inicial${currency ? ` en ${currency}` : ''} ya tiene pagos aplicados; corrígela con "Conciliar" para dejar un ajuste`,
    );
  }
  if (debt === 0) {
    // Registro único creado por error: se elimina con su cuota y su movimiento.
    await tx.cardInstallment.deleteMany({ where: { chargeId: charge.id } });
    await tx.cardCharge.delete({ where: { id: charge.id } });
    await tx.cashMovement.delete({ where: { id: charge.movementId } });
    return;
  }
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: card.entityId }, select: { currency: true } });
  const rateAtTx = charge.exchangeRateAtTx ? rate4(charge.exchangeRateAtTx.toString()) : null;
  const amountBase = currency && rateAtTx ? convertPair(debt, currency, entity.currency, rateAtTx) : debt;
  const { statementDate, dueDate } = installmentDates(date, 1, cycle, true);
  await tx.cashMovement.update({ where: { id: charge.movementId }, data: { amount: dec(-debt), date: dbDate(date) } });
  await tx.cardCharge.update({
    where: { id: charge.id },
    data: { amount: dec(debt), amountBase: dec(amountBase), purchaseDate: dbDate(date) },
  });
  await tx.cardInstallment.updateMany({
    where: { chargeId: charge.id },
    data: { amount: dec(debt), statementDate: dbDate(statementDate), dueDate: dbDate(dueDate) },
  });
}

export async function setOpening(
  tx: Tx,
  account: Account,
  args: { currency: string | null; amount: Cents; date: ISODate; userId: string },
) {
  if (account.type === 'CREDIT_CARD') {
    if (args.currency && args.currency !== account.foreignCurrency) throw badRequest('La tarjeta no maneja esa moneda');
    return setCardOpening(tx, account, args.currency, args.amount, args.date, args.userId);
  }
  if (args.currency) throw badRequest('Las cuentas líquidas solo tienen saldo en la moneda de la entidad');
  return setLiquidOpening(tx, account, args.amount, args.date, args.userId);
}

/**
 * Recalcula corte y fecha de pago de las cuotas no liquidadas con el ciclo vigente de la tarjeta.
 * Las cuotas ya pagadas conservan sus fechas. Devuelve cuántas cuotas cambiaron.
 */
export async function rescheduleCardInstallments(tx: Tx, card: Account): Promise<number> {
  const cycle = cardCycleOf(card);
  const rows = await tx.cardInstallment.findMany({
    where: { cardAccountId: card.id },
    include: { charge: { select: { purchaseDate: true, isOpening: true } } },
  });
  let changed = 0;
  for (const r of rows) {
    if (cents(r.settledAmount) >= cents(r.amount)) continue;
    const d = installmentDates(isoOf(r.charge.purchaseDate), r.number, cycle, r.charge.isOpening);
    if (d.statementDate === isoOf(r.statementDate) && d.dueDate === isoOf(r.dueDate)) continue;
    await tx.cardInstallment.update({
      where: { id: r.id },
      data: { statementDate: dbDate(d.statementDate), dueDate: dbDate(d.dueDate) },
    });
    changed++;
  }
  return changed;
}
