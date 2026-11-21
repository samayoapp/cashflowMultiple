import { addDays, addMonths, diffDays, type ISODate } from '@/lib/dates';
import type { Cents } from '@/lib/money';

/**
 * Ciclos de tarjeta de crédito (funciones puras).
 *
 *  - Corte (statementDay): día del mes en que cierra el estado de cuenta.
 *  - Pago (paymentDueDay): día límite de pago, siempre POSTERIOR al corte.
 *  - Días inexistentes (31 en febrero) se ajustan al último día del mes.
 */
export interface CardCycleConfig {
  statementDay: number;
  paymentDueDay: number;
}

export interface ScheduledInstallment {
  number: number; // 1..N
  count: number; // N
  amount: Cents;
  statementDate: ISODate;
  dueDate: ISODate;
}

const firstOfMonth = (iso: ISODate): ISODate => iso.slice(0, 8) + '01';

/** Fecha con el día `day` en el mes de `iso` desplazado `months` (ajustada a fin de mes). */
export function dayInMonth(iso: ISODate, day: number, months = 0): ISODate {
  return addMonths(firstOfMonth(iso), months, day);
}

/** Corte que cubre una compra: el del mismo mes si la compra es <= corte; si no, el siguiente. */
export function statementCloseFor(purchase: ISODate, statementDay: number): ISODate {
  const sameMonth = dayInMonth(purchase, statementDay);
  return purchase <= sameMonth ? sameMonth : dayInMonth(purchase, statementDay, 1);
}

/** Primera fecha con día `paymentDueDay` estrictamente posterior al corte. */
export function dueDateFor(statementDate: ISODate, paymentDueDay: number): ISODate {
  const sameMonth = dayInMonth(statementDate, paymentDueDay);
  return sameMonth > statementDate ? sameMonth : dayInMonth(statementDate, paymentDueDay, 1);
}

/** Corte cuyo pago vence en `dueDate` (inverso de dueDateFor). */
export function statementForDueDate(dueDate: ISODate, card: CardCycleConfig): ISODate {
  for (const months of [0, -1, -2]) {
    const close = dayInMonth(dueDate, card.statementDay, months);
    if (close < dueDate && dueDateFor(close, card.paymentDueDay) === dueDate) return close;
  }
  return dueDate;
}

/** Próxima fecha con día `day` a partir de `from` (inclusive). */
export function nextDayOnOrAfter(from: ISODate, day: number): ISODate {
  const sameMonth = dayInMonth(from, day);
  return sameMonth >= from ? sameMonth : dayInMonth(from, day, 1);
}

/** Fecha límite de pago en la que impacta una compra hecha en `purchase`. */
export function paymentDateForPurchase(purchase: ISODate, card: CardCycleConfig): ISODate {
  return dueDateFor(statementCloseFor(purchase, card.statementDay), card.paymentDueDay);
}

/** Divide en N cuotas exactas: los centavos sobrantes van en las primeras. */
export function splitInstallments(total: Cents, n: number): Cents[] {
  if (!Number.isInteger(n) || n < 1) throw new Error('Número de cuotas inválido');
  if (!Number.isInteger(total) || total <= 0) throw new Error('Monto inválido');
  const base = Math.floor(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

/** Calendario de cuotas: la cuota k cae en el k-ésimo corte desde el de la compra. */
export function buildSchedule(purchase: ISODate, total: Cents, n: number, card: CardCycleConfig): ScheduledInstallment[] {
  const firstClose = statementCloseFor(purchase, card.statementDay);
  return splitInstallments(total, n).map((amount, i) => {
    const statementDate = dayInMonth(firstClose, card.statementDay, i);
    return { number: i + 1, count: n, amount, statementDate, dueDate: dueDateFor(statementDate, card.paymentDueDay) };
  });
}

export interface PendingInstallment {
  id: string;
  dueDate: ISODate;
  number: number;
  pending: Cents;
  purchaseDate?: ISODate;
}

/**
 * Reparte un pago entre cuotas pendientes en orden FIFO (fecha de pago, compra, número de cuota).
 * `rest` = parte del pago que no cubrió cuotas (p. ej. intereses ajustados por conciliación).
 */
export function allocatePayment(
  installments: PendingInstallment[],
  amount: Cents,
): { allocations: { installmentId: string; amount: Cents }[]; rest: Cents } {
  const sorted = installments
    .filter((i) => i.pending > 0)
    .slice()
    .sort((a, b) =>
      a.dueDate !== b.dueDate
        ? a.dueDate < b.dueDate
          ? -1
          : 1
        : (a.purchaseDate ?? '') !== (b.purchaseDate ?? '')
          ? (a.purchaseDate ?? '') < (b.purchaseDate ?? '')
            ? -1
            : 1
          : a.number - b.number,
    );
  const allocations: { installmentId: string; amount: Cents }[] = [];
  let left = amount;
  for (const inst of sorted) {
    if (left <= 0) break;
    const take = Math.min(left, inst.pending);
    allocations.push({ installmentId: inst.id, amount: take });
    left -= take;
  }
  return { allocations, rest: left };
}

/**
 * Fechas (corte y pago) de la cuota `number` de un consumo, según el ciclo vigente de la tarjeta.
 * La deuda inicial se paga en la próxima fecha de pago a partir de su registro.
 * Se usa para re-programar cuotas pendientes cuando cambian el día de corte o de pago.
 */
export function installmentDates(
  purchase: ISODate,
  number: number,
  card: CardCycleConfig,
  isOpening = false,
): { statementDate: ISODate; dueDate: ISODate } {
  if (isOpening) {
    const dueDate = nextDayOnOrAfter(purchase, card.paymentDueDay);
    return { statementDate: statementForDueDate(dueDate, card), dueDate };
  }
  const statementDate = dayInMonth(statementCloseFor(purchase, card.statementDay), card.statementDay, number - 1);
  return { statementDate, dueDate: dueDateFor(statementDate, card.paymentDueDay) };
}

/** Ciclo de facturación en curso: del día siguiente al último corte hasta el próximo corte (inclusive). */
export interface CycleProgress {
  start: ISODate;
  close: ISODate;
  dueDate: ISODate;
  daysElapsed: number;
  daysTotal: number;
  daysLeft: number;
  /** Lo que se va a facturar en el corte: compras nuevas + cuotas de compras anteriores. */
  accumulated: Cents;
  /** Proyección al corte si se sigue gastando al mismo ritmo diario (las cuotas fijas no se extrapolan). */
  projectedAtClose: Cents;
  /** Presupuesto del ciclo y cuánto queda; null si no hay presupuesto. */
  budget: Cents | null;
  budgetLeft: Cents | null;
  /** Monto diario que se puede gastar hasta el corte sin pasarse del presupuesto. */
  dailyAllowance: Cents | null;
}

export function cycleProgress(args: {
  today: ISODate;
  card: CardCycleConfig;
  /** Compras hechas dentro del ciclo (primera cuota o pago único). */
  newSpend: Cents;
  /** Cuotas de compras anteriores que caen en este corte. */
  carried: Cents;
  budget?: Cents | null;
}): CycleProgress {
  const close = statementCloseFor(args.today, args.card.statementDay);
  const start = addDays(dayInMonth(close, args.card.statementDay, -1), 1);
  const daysTotal = diffDays(close, start) + 1;
  const daysElapsed = Math.min(Math.max(diffDays(args.today, start) + 1, 1), daysTotal);
  const daysLeft = daysTotal - daysElapsed;
  const accumulated = args.newSpend + args.carried;
  const projectedAtClose = args.carried + Math.round((args.newSpend * daysTotal) / daysElapsed);
  const budget = args.budget ?? null;
  const budgetLeft = budget === null ? null : budget - accumulated;
  const dailyAllowance =
    budgetLeft === null ? null : Math.max(0, Math.floor(budgetLeft / Math.max(daysLeft + 1, 1)));
  return {
    start,
    close,
    dueDate: dueDateFor(close, args.card.paymentDueDay),
    daysElapsed,
    daysTotal,
    daysLeft,
    accumulated,
    projectedAtClose,
    budget,
    budgetLeft,
    dailyAllowance,
  };
}

/** Monto de una tarjeta separado por moneda: la de la unidad (base) y la extranjera (bimoneda). */
export interface CardMoney {
  base: Cents;
  foreign: Cents;
}

export interface DebtInstallment {
  statementDate: ISODate;
  dueDate: ISODate;
  /** Lo que falta pagar de la cuota. */
  pending: Cents;
  /** Cuota en la moneda extranjera de la tarjeta. */
  foreign: boolean;
}

export interface CardDebtBuckets {
  /** Ya facturado (cortes cerrados) y sin pagar: lo que se debe a la fecha de pago. */
  billed: CardMoney;
  /** Fecha de pago más próxima de lo facturado pendiente (puede estar vencida). */
  billedDueDate: ISODate | null;
  /** Lo que se factura en el próximo corte (ciclo en curso). */
  nextCut: CardMoney;
  /** Cuotas que caen en cortes posteriores al próximo. */
  later: CardMoney;
}

/**
 * Separa la deuda pendiente de una tarjeta según su corte: facturado (a pagar en la fecha de pago),
 * al próximo corte y cuotas futuras. `currentClose` es el corte del ciclo en curso (el de hoy o el
 * siguiente); sin día de corte configurado, todo cuenta como facturado.
 */
export function cardDebtBuckets(items: readonly DebtInstallment[], currentClose: ISODate | null): CardDebtBuckets {
  const out: CardDebtBuckets = { billed: { base: 0, foreign: 0 }, billedDueDate: null, nextCut: { base: 0, foreign: 0 }, later: { base: 0, foreign: 0 } };
  for (const i of items) {
    if (i.pending <= 0) continue;
    const k: keyof CardMoney = i.foreign ? 'foreign' : 'base';
    if (!currentClose || i.statementDate < currentClose) {
      out.billed[k] += i.pending;
      if (!out.billedDueDate || i.dueDate < out.billedDueDate) out.billedDueDate = i.dueDate;
    } else if (i.statementDate === currentClose) out.nextCut[k] += i.pending;
    else out.later[k] += i.pending;
  }
  return out;
}
