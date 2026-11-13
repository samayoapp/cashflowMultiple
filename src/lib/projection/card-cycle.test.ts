import { describe, expect, it } from 'vitest';
import {
  allocatePayment,
  buildSchedule,
  dueDateFor,
  installmentDates,
  nextDayOnOrAfter,
  paymentDateForPurchase,
  splitInstallments,
  statementCloseFor,
  statementForDueDate,
} from './card-cycle';

const VISA = { statementDay: 15, paymentDueDay: 5 };

describe('ciclos de tarjeta', () => {
  it('compra antes, el día y después del corte', () => {
    expect(statementCloseFor('2026-11-10', 15)).toBe('2026-11-15');
    expect(statementCloseFor('2026-11-15', 15)).toBe('2026-11-15');
    expect(statementCloseFor('2026-11-16', 15)).toBe('2026-12-15');
    expect(paymentDateForPurchase('2026-11-10', VISA)).toBe('2026-12-05');
    expect(paymentDateForPurchase('2026-11-15', VISA)).toBe('2026-12-05');
    expect(paymentDateForPurchase('2026-11-16', VISA)).toBe('2027-01-05');
  });

  it('cruza diciembre → enero', () => {
    expect(statementCloseFor('2026-12-20', 15)).toBe('2027-01-15');
    expect(paymentDateForPurchase('2026-12-20', VISA)).toBe('2027-02-05');
  });

  it('corte 31 se ajusta al fin de mes (febrero)', () => {
    expect(statementCloseFor('2027-02-10', 31)).toBe('2027-02-28');
    expect(statementCloseFor('2028-02-29', 31)).toBe('2028-02-29');
    expect(statementCloseFor('2027-01-31', 31)).toBe('2027-01-31');
    expect(dueDateFor('2027-02-28', 30)).toBe('2027-03-30');
  });

  it('día de pago mayor que el corte cae en el mismo mes', () => {
    expect(dueDateFor('2026-11-05', 25)).toBe('2026-11-25');
    expect(paymentDateForPurchase('2026-11-03', { statementDay: 5, paymentDueDay: 25 })).toBe('2026-11-25');
    // mismo día de corte y pago => el mes siguiente
    expect(dueDateFor('2026-11-15', 15)).toBe('2026-12-15');
  });

  it('corte correspondiente a una fecha de pago', () => {
    expect(statementForDueDate('2026-12-05', VISA)).toBe('2026-11-15');
    expect(statementForDueDate('2026-11-25', { statementDay: 5, paymentDueDay: 25 })).toBe('2026-11-05');
    expect(statementForDueDate('2027-03-30', { statementDay: 31, paymentDueDay: 30 })).toBe('2027-02-28');
  });

  it('próximo día a partir de una fecha (inclusive)', () => {
    expect(nextDayOnOrAfter('2026-11-05', 5)).toBe('2026-11-05');
    expect(nextDayOnOrAfter('2026-11-06', 5)).toBe('2026-12-05');
  });
});

describe('cuotas', () => {
  it('reparte centavos sobrantes en las primeras cuotas', () => {
    expect(splitInstallments(100_00, 3)).toEqual([33_34, 33_33, 33_33]);
    expect(splitInstallments(10, 3)).toEqual([4, 3, 3]);
    const parts = splitInstallments(6000_01, 6);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(6000_01);
    expect(() => splitInstallments(100, 0)).toThrow();
  });

  it('cada cuota cae en un corte sucesivo', () => {
    const s = buildSchedule('2026-11-20', 6000_00, 6, VISA);
    expect(s.map((i) => i.dueDate)).toEqual([
      '2027-01-05',
      '2027-02-05',
      '2027-03-05',
      '2027-04-05',
      '2027-05-05',
      '2027-06-05',
    ]);
    expect(s[0]).toMatchObject({ number: 1, count: 6, amount: 1000_00, statementDate: '2026-12-15' });
  });

  it('corte 31 mantiene el ancla a lo largo de las cuotas', () => {
    const s = buildSchedule('2027-01-20', 300_00, 3, { statementDay: 31, paymentDueDay: 20 });
    expect(s.map((i) => i.statementDate)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
    expect(s.map((i) => i.dueDate)).toEqual(['2027-02-20', '2027-03-20', '2027-04-20']);
  });
});

describe('asignación de pagos', () => {
  const inst = [
    { id: 'b', dueDate: '2027-01-05', number: 2, pending: 500_00, purchaseDate: '2026-11-01' },
    { id: 'a', dueDate: '2026-12-05', number: 1, pending: 300_00, purchaseDate: '2026-11-01' },
    { id: 'c', dueDate: '2026-12-05', number: 1, pending: 200_00, purchaseDate: '2026-11-10' },
    { id: 'z', dueDate: '2026-12-01', number: 1, pending: 0 },
  ];

  it('paga FIFO por fecha de pago y compra; parcial en la última', () => {
    const r = allocatePayment(inst, 600_00);
    expect(r.allocations).toEqual([
      { installmentId: 'a', amount: 300_00 },
      { installmentId: 'c', amount: 200_00 },
      { installmentId: 'b', amount: 100_00 },
    ]);
    expect(r.rest).toBe(0);
  });

  it('devuelve el sobrante cuando el pago excede las cuotas', () => {
    const r = allocatePayment(inst, 1100_00);
    expect(r.allocations.reduce((s, a) => s + a.amount, 0)).toBe(1000_00);
    expect(r.rest).toBe(100_00);
  });
});

describe('re-programación de cuotas', () => {
  it('coincide con buildSchedule para cada cuota', () => {
    const s = buildSchedule('2026-01-20', 90000, 3, VISA);
    for (const i of s) {
      expect(installmentDates('2026-01-20', i.number, VISA)).toEqual({ statementDate: i.statementDate, dueDate: i.dueDate });
    }
  });

  it('cambiar el ciclo mueve las fechas', () => {
    // Compra 10-ene: con corte 15/pago 5 vence 5-feb; con corte 3/pago 24 cae en el corte 3-feb y vence 24-feb
    expect(installmentDates('2026-01-10', 1, VISA).dueDate).toBe('2026-02-05');
    expect(installmentDates('2026-01-10', 1, { statementDay: 3, paymentDueDay: 24 })).toEqual({
      statementDate: '2026-02-03',
      dueDate: '2026-02-24',
    });
  });

  it('deuda inicial: próxima fecha de pago desde su registro', () => {
    expect(installmentDates('2026-11-13', 1, { statementDay: 3, paymentDueDay: 24 }, true)).toEqual({
      statementDate: '2026-11-03',
      dueDate: '2026-11-24',
    });
    expect(installmentDates('2026-11-13', 1, VISA, true).dueDate).toBe('2026-12-05');
  });
});
