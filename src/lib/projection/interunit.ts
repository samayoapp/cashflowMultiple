import type { ISODate } from '@/lib/dates';
import type { Cents } from '@/lib/money';

/**
 * Estado de cuenta ENTRE UNIDADES de negocio: quién le debe a quién, por par de unidades.
 * Función pura.
 *
 * Generan deuda:
 *  - Reembolsos (gasto de una unidad pagado con tarjeta de otra) → debe quien reembolsa (origen).
 *  - Devoluciones de préstamo → debe quien devuelve (origen).
 *  - Préstamos ENTREGADOS sin devolución programada → debe quien recibió (destino), por el principal.
 * No generan deuda: aportes y transferencias simples, ni préstamos aún no entregados.
 */

export type InterUnitKind = 'REIMBURSEMENT' | 'REPAYMENT' | 'LOAN';

export interface InterUnitTransfer {
  id: string;
  kind: 'LOAN' | 'CONTRIBUTION' | 'TRANSFER';
  status: 'PLANNED' | 'EXECUTED' | 'CANCELLED';
  isReimbursement: boolean;
  repaymentOfId: string | null;
  /** Préstamo: tiene devolución programada (no cancelada). */
  hasRepayment: boolean;
  fromEntityId: string;
  toEntityId: string;
  amountFrom: Cents;
  amountTo: Cents;
  paidFrom: Cents;
  paidTo: Cents;
  expectedDate: ISODate;
  executedDate: ISODate | null;
  /** Reembolsos: fecha en que se hizo el gasto. */
  expenseDate?: ISODate | null;
  description: string | null;
  interest: Cents;
}

export interface InterUnitItem {
  transferId: string;
  kind: InterUnitKind;
  /** Estado de la deuda. */
  state: 'OPEN' | 'PARTIAL' | 'SETTLED' | 'CANCELLED' | 'NO_PLAN';
  date: ISODate;
  /** Reembolsos: fecha en que se hizo el gasto (`date` es la del reembolso). */
  expenseDate: ISODate | null;
  description: string | null;
  debtorId: string;
  creditorId: string;
  /** Montos en la moneda de QUIEN COBRA. */
  original: Cents;
  paid: Cents;
  pending: Cents;
  /** Pendiente en la moneda de quien debe. */
  pendingDebtor: Cents;
  interest: Cents;
}

export interface InterUnitPair {
  /** ids ordenados: a < b */
  a: string;
  b: string;
  /** Pendiente que A le debe a B (en moneda de B) y viceversa (en moneda de A). */
  aOwesB: Cents;
  bOwesA: Cents;
  items: InterUnitItem[];
}

export function buildInterUnitStatement(transfers: InterUnitTransfer[], entityIds?: readonly string[]): InterUnitPair[] {
  const scope = entityIds ? new Set(entityIds) : null;
  const pairs = new Map<string, InterUnitPair>();

  for (const t of transfers) {
    if (scope && !scope.has(t.fromEntityId) && !scope.has(t.toEntityId)) continue;
    let item: InterUnitItem | null = null;

    if (t.isReimbursement || t.repaymentOfId) {
      const pending = t.status === 'PLANNED' ? Math.max(t.amountTo - t.paidTo, 0) : 0;
      item = {
        transferId: t.id,
        kind: t.isReimbursement ? 'REIMBURSEMENT' : 'REPAYMENT',
        state:
          t.status === 'CANCELLED' ? 'CANCELLED' : t.status === 'EXECUTED' || pending === 0 ? 'SETTLED' : t.paidTo > 0 ? 'PARTIAL' : 'OPEN',
        date: t.expectedDate,
        expenseDate: t.expenseDate ?? null,
        description: t.description,
        debtorId: t.fromEntityId,
        creditorId: t.toEntityId,
        original: t.amountTo,
        paid: t.paidTo,
        pending,
        pendingDebtor: t.status === 'PLANNED' ? Math.max(t.amountFrom - t.paidFrom, 0) : 0,
        interest: t.interest,
      };
    } else if (t.kind === 'LOAN' && t.status === 'EXECUTED') {
      // El préstamo entregado: su deuda vive en la devolución, si existe; si no, es el principal.
      item = {
        transferId: t.id,
        kind: 'LOAN',
        state: t.hasRepayment ? 'SETTLED' : 'NO_PLAN',
        date: t.executedDate ?? t.expectedDate,
        expenseDate: null,
        description: t.description,
        debtorId: t.toEntityId,
        creditorId: t.fromEntityId,
        original: t.amountFrom,
        paid: 0,
        pending: t.hasRepayment ? 0 : t.amountFrom,
        pendingDebtor: t.hasRepayment ? 0 : t.amountTo,
        interest: 0,
      };
    }
    if (!item) continue;

    const [a, b] = item.debtorId < item.creditorId ? [item.debtorId, item.creditorId] : [item.creditorId, item.debtorId];
    const key = `${a}|${b}`;
    const pair = pairs.get(key) ?? { a, b, aOwesB: 0, bOwesA: 0, items: [] };
    if (item.debtorId === a) pair.aOwesB += item.pending;
    else pair.bOwesA += item.pending;
    pair.items.push(item);
    pairs.set(key, pair);
  }

  const list = Array.from(pairs.values());
  for (const p of list) p.items.sort((x, y) => (x.date === y.date ? 0 : x.date < y.date ? 1 : -1));
  // Primero los pares con saldo pendiente
  return list.sort((x, y) => y.aOwesB + y.bOwesA - (x.aOwesB + x.bOwesA));
}
