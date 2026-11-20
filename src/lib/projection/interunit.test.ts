import { describe, expect, it } from 'vitest';
import { buildInterUnitStatement, type InterUnitTransfer } from './interunit';

function tr(p: Partial<InterUnitTransfer> & { id: string }): InterUnitTransfer {
  return {
    kind: 'TRANSFER',
    status: 'PLANNED',
    isReimbursement: false,
    repaymentOfId: null,
    hasRepayment: false,
    fromEntityId: 'NEG',
    toEntityId: 'FAM',
    amountFrom: 1_000_00,
    amountTo: 1_000_00,
    paidFrom: 0,
    paidTo: 0,
    expectedDate: '2026-11-30',
    executedDate: null,
    description: null,
    interest: 0,
    ...p,
  };
}

describe('estado de cuenta entre unidades', () => {
  it('reembolsos: debe quien reembolsa, con abonos y saldados', () => {
    const [pair] = buildInterUnitStatement([
      tr({ id: 'r1', isReimbursement: true, paidFrom: 400_00, paidTo: 400_00 }),
      tr({ id: 'r2', isReimbursement: true, amountFrom: 500_00, amountTo: 500_00 }),
      tr({ id: 'r3', isReimbursement: true, status: 'EXECUTED', paidFrom: 1_000_00, paidTo: 1_000_00 }),
    ]);
    // 'FAM' < 'NEG': a = FAM, b = NEG → NEG le debe a FAM
    expect(pair).toMatchObject({ a: 'FAM', b: 'NEG', aOwesB: 0, bOwesA: 1_100_00 });
    const byId = Object.fromEntries(pair.items.map((i) => [i.transferId, i]));
    expect(byId.r1).toMatchObject({ state: 'PARTIAL', pending: 600_00, debtorId: 'NEG', creditorId: 'FAM' });
    expect(byId.r2.state).toBe('OPEN');
    expect(byId.r3).toMatchObject({ state: 'SETTLED', pending: 0 });
  });

  it('reembolsos: conservan la fecha del gasto aparte de la fecha de reembolso', () => {
    const [pair] = buildInterUnitStatement([
      tr({ id: 'r1', isReimbursement: true, expenseDate: '2026-03-12', expectedDate: '2026-11-30' }),
      tr({ id: 'r2', isReimbursement: true }),
    ]);
    const byId = Object.fromEntries(pair.items.map((i) => [i.transferId, i]));
    expect(byId.r1).toMatchObject({ date: '2026-11-30', expenseDate: '2026-03-12' });
    expect(byId.r2.expenseDate).toBeNull();
  });

  it('préstamo entregado sin devolución: debe quien lo recibió; con devolución, la deuda vive en la devolución', () => {
    const noPlan = buildInterUnitStatement([tr({ id: 'l1', kind: 'LOAN', status: 'EXECUTED', fromEntityId: 'FAM', toEntityId: 'NEG' })]);
    expect(noPlan[0]).toMatchObject({ bOwesA: 1_000_00, aOwesB: 0 });
    expect(noPlan[0].items[0]).toMatchObject({ kind: 'LOAN', state: 'NO_PLAN', debtorId: 'NEG' });

    const planned = buildInterUnitStatement([
      tr({ id: 'l1', kind: 'LOAN', status: 'EXECUTED', fromEntityId: 'FAM', toEntityId: 'NEG', hasRepayment: true }),
      tr({ id: 'd1', kind: 'TRANSFER', repaymentOfId: 'l1', fromEntityId: 'NEG', toEntityId: 'FAM', amountFrom: 1_050_00, amountTo: 1_050_00, interest: 50_00 }),
    ]);
    expect(planned[0]).toMatchObject({ bOwesA: 1_050_00, aOwesB: 0 });
  });

  it('ignora aportes, transferencias simples y préstamos sin entregar; cuenta ambos sentidos', () => {
    const r = buildInterUnitStatement([
      tr({ id: 't1' }),
      tr({ id: 'c1', kind: 'CONTRIBUTION', status: 'EXECUTED' }),
      tr({ id: 'l0', kind: 'LOAN' }),
      tr({ id: 'r1', isReimbursement: true }),
      tr({ id: 'r2', isReimbursement: true, fromEntityId: 'FAM', toEntityId: 'NEG', amountFrom: 300_00, amountTo: 300_00 }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ aOwesB: 300_00, bOwesA: 1_000_00 });
    expect(r[0].items).toHaveLength(2);
  });

  it('cancelados no suman y se filtra por unidades del contexto', () => {
    const r = buildInterUnitStatement(
      [
        tr({ id: 'r1', isReimbursement: true, status: 'CANCELLED', paidTo: 100_00 }),
        tr({ id: 'r2', isReimbursement: true, fromEntityId: 'X', toEntityId: 'Y' }),
      ],
      ['FAM'],
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ aOwesB: 0, bOwesA: 0 });
    expect(r[0].items[0].state).toBe('CANCELLED');
  });
});
