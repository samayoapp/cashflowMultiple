import type { Cents } from '@/lib/money';

export type SettlementStatus = 'OPEN' | 'PARTIAL' | 'SETTLED';

/**
 * Liquidación con monto real: al "Marcar como pagado/cobrado" el último abono puede diferir
 * de lo proyectado. La partida se cierra y su monto pasa a ser el real (pagado + este abono);
 * el monto proyectado original se conserva en `projectedAmount` (solo la primera vez).
 */
export function settleWithActual(args: {
  amount: Cents;
  projectedAmount: Cents | null;
  paid: Cents;
  payment: Cents;
}): { amount: Cents; projectedAmount: Cents | null; status: 'SETTLED' } {
  if (args.payment <= 0) throw new Error('El monto real debe ser positivo');
  const actual = args.paid + args.payment;
  const original = args.projectedAmount ?? args.amount;
  return { amount: actual, projectedAmount: actual === original ? null : original, status: 'SETTLED' };
}

/**
 * Al deshacer un abono de una partida ajustada se vuelve a la proyección original,
 * salvo que lo ya pagado la supere (entonces el monto queda en lo pagado).
 */
export function afterPaymentUndo(args: {
  amount: Cents;
  projectedAmount: Cents | null;
  paid: Cents;
}): { amount: Cents; projectedAmount: Cents | null; status: SettlementStatus } {
  let amount = args.amount;
  let projectedAmount = args.projectedAmount;
  if (projectedAmount !== null) {
    amount = Math.max(projectedAmount, args.paid);
    if (amount === projectedAmount) projectedAmount = null;
  }
  const status: SettlementStatus = args.paid === 0 ? 'OPEN' : args.paid >= amount ? 'SETTLED' : 'PARTIAL';
  return { amount, projectedAmount, status };
}
