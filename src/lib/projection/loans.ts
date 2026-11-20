import type { Cents } from '@/lib/money';

/**
 * Préstamos entre unidades de negocio: aritmética pura (centavos enteros).
 * Quien presta entrega `principalLender` (su moneda) y quien recibe obtiene `principalBorrower`
 * (la suya). El interés se pacta en la moneda de quien presta y se convierte a la tasa del préstamo.
 */
export function repaymentTotals(principalLender: Cents, principalBorrower: Cents, interest: Cents) {
  if (principalLender <= 0 || principalBorrower <= 0) throw new Error('El préstamo debe tener monto');
  if (interest < 0) throw new Error('El interés no puede ser negativo');
  const interestBorrower =
    principalLender === principalBorrower ? interest : Math.round((interest * principalBorrower) / principalLender);
  return { lender: principalLender + interest, borrower: principalBorrower + interestBorrower, interestBorrower };
}

/**
 * Reparte un abono entre los dos lados de una transferencia.
 * `remOut`/`remIn`: saldo pendiente de quien paga / quien recibe. Sin `payOut` se liquida todo.
 * El abono que completa el saldo cierra exacto ambos lados (sin centavos sueltos por redondeo);
 * los intermedios convierten en proporción salvo que se indique lo recibido (`payIn`).
 */
export function splitTransferPayment(
  remOut: Cents,
  remIn: Cents,
  payOut?: Cents,
  payIn?: Cents,
): { out: Cents; in: Cents; closes: boolean } {
  if (payOut === undefined) return { out: remOut, in: remIn, closes: true };
  if (payOut <= 0) throw new Error('El abono debe ser mayor que cero');
  if (payOut > remOut) throw new Error('El abono supera el saldo pendiente');
  if (payOut === remOut) return { out: remOut, in: remIn, closes: true };
  const inn = payIn ?? Math.round((payOut * remIn) / remOut);
  if (inn <= 0 || inn >= remIn) throw new Error('El monto recibido no cuadra con el saldo pendiente');
  return { out: payOut, in: inn, closes: false };
}

/**
 * Nuevo monto de una transferencia entre unidades al EDITARLA (p. ej. corregir un reembolso).
 * `newFrom`: lo que debe la unidad origen (su moneda). `newTo`: lo que recibe el destino;
 * si no se indica, es igual (misma moneda) o se convierte a la misma tasa que tenía.
 * Ningún lado puede quedar en o por debajo de lo ya abonado: para dejarlo en lo abonado se cancela el saldo.
 */
export function editTransferAmounts(args: {
  oldFrom: Cents;
  oldTo: Cents;
  paidFrom: Cents;
  paidTo: Cents;
  newFrom: Cents;
  newTo?: Cents;
  sameCurrency: boolean;
}): { from: Cents; to: Cents } {
  const { oldFrom, oldTo, paidFrom, paidTo, newFrom, sameCurrency } = args;
  if (newFrom <= 0) throw new Error('El monto debe ser mayor que cero');
  const to = sameCurrency ? newFrom : (args.newTo ?? Math.round((newFrom * oldTo) / oldFrom));
  if (to <= 0) throw new Error('El monto recibido debe ser mayor que cero');
  if (newFrom <= paidFrom || to <= paidTo) {
    throw new Error('El monto debe ser mayor que lo ya abonado; para dejarlo en lo abonado, cancela el saldo pendiente');
  }
  return { from: newFrom, to };
}
