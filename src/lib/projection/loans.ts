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
