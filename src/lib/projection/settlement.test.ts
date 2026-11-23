import { describe, expect, it } from 'vitest';
import { afterPaymentUndo, settleWithActual } from './settlement';

describe('liquidar con monto real', () => {
  it('mismo monto que lo proyectado: no guarda proyección', () => {
    expect(settleWithActual({ amount: 1_250_00, projectedAmount: null, paid: 0, payment: 1_250_00 })).toEqual({
      amount: 1_250_00,
      projectedAmount: null,
      status: 'SETTLED',
    });
  });

  it('real menor: cierra con el real y conserva lo proyectado', () => {
    expect(settleWithActual({ amount: 1_250_00, projectedAmount: null, paid: 0, payment: 1_180_00 })).toEqual({
      amount: 1_180_00,
      projectedAmount: 1_250_00,
      status: 'SETTLED',
    });
  });

  it('real mayor: cierra con el real', () => {
    expect(settleWithActual({ amount: 1_000_00, projectedAmount: null, paid: 0, payment: 1_100_00 })).toMatchObject({
      amount: 1_100_00,
      projectedAmount: 1_000_00,
    });
  });

  it('con abonos previos, el real es lo pagado más el último abono', () => {
    expect(settleWithActual({ amount: 1_000_00, projectedAmount: null, paid: 500_00, payment: 400_00 })).toMatchObject({
      amount: 900_00,
      projectedAmount: 1_000_00,
    });
  });

  it('conserva la proyección original si ya había un ajuste', () => {
    expect(settleWithActual({ amount: 900_00, projectedAmount: 1_000_00, paid: 0, payment: 950_00 })).toMatchObject({
      amount: 950_00,
      projectedAmount: 1_000_00,
    });
    expect(settleWithActual({ amount: 900_00, projectedAmount: 1_000_00, paid: 0, payment: 1_000_00 }).projectedAmount).toBeNull();
  });

  it('rechaza montos no positivos', () => {
    expect(() => settleWithActual({ amount: 100_00, projectedAmount: null, paid: 0, payment: 0 })).toThrow();
  });
});

describe('deshacer un abono', () => {
  it('sin ajuste solo recalcula el estado', () => {
    expect(afterPaymentUndo({ amount: 1_000_00, projectedAmount: null, paid: 0 })).toEqual({ amount: 1_000_00, projectedAmount: null, status: 'OPEN' });
    expect(afterPaymentUndo({ amount: 1_000_00, projectedAmount: null, paid: 400_00 }).status).toBe('PARTIAL');
  });

  it('restaura la proyección original', () => {
    expect(afterPaymentUndo({ amount: 1_180_00, projectedAmount: 1_250_00, paid: 0 })).toEqual({
      amount: 1_250_00,
      projectedAmount: null,
      status: 'OPEN',
    });
    expect(afterPaymentUndo({ amount: 900_00, projectedAmount: 1_000_00, paid: 500_00 })).toEqual({
      amount: 1_000_00,
      projectedAmount: null,
      status: 'PARTIAL',
    });
  });

  it('si lo pagado supera la proyección, el monto queda en lo pagado', () => {
    expect(afterPaymentUndo({ amount: 1_200_00, projectedAmount: 1_000_00, paid: 1_100_00 })).toEqual({
      amount: 1_100_00,
      projectedAmount: 1_000_00,
      status: 'SETTLED',
    });
  });
});
