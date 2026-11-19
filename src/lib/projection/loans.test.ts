import { describe, expect, it } from 'vitest';
import { repaymentTotals, splitTransferPayment } from './loans';

describe('préstamos entre unidades', () => {
  it('sin interés se devuelve lo mismo que se prestó', () => {
    expect(repaymentTotals(50_000_00, 50_000_00, 0)).toEqual({ lender: 50_000_00, borrower: 50_000_00, interestBorrower: 0 });
  });

  it('el interés se suma en ambas monedas a la tasa del préstamo', () => {
    // HNL 25,000 → USD 1,000 (tasa 25); interés L 500 → $20
    expect(repaymentTotals(25_000_00, 1_000_00, 500_00)).toEqual({ lender: 25_500_00, borrower: 1_020_00, interestBorrower: 20_00 });
  });

  it('rechaza interés negativo', () => {
    expect(() => repaymentTotals(100_00, 100_00, -1)).toThrow();
  });

  it('sin monto liquida todo lo pendiente', () => {
    expect(splitTransferPayment(30_000_00, 30_000_00)).toEqual({ out: 30_000_00, in: 30_000_00, closes: true });
  });

  it('abonos parciales hasta cerrar exacto', () => {
    let remOut = 1_000_00;
    let remIn = 1_000_00;
    for (const abono of [300_00, 300_00]) {
      const r = splitTransferPayment(remOut, remIn, abono);
      expect(r).toEqual({ out: abono, in: abono, closes: false });
      remOut -= r.out;
      remIn -= r.in;
    }
    expect(splitTransferPayment(remOut, remIn, 400_00)).toEqual({ out: 400_00, in: 400_00, closes: true });
  });

  it('con monedas distintas convierte en proporción y el último abono absorbe el redondeo', () => {
    const first = splitTransferPayment(1_020_00, 25_500_00, 333_33);
    expect(first).toEqual({ out: 333_33, in: 8_333_25, closes: false });
    const last = splitTransferPayment(1_020_00 - 333_33, 25_500_00 - 8_333_25, 1_020_00 - 333_33);
    expect(last).toEqual({ out: 686_67, in: 17_166_75, closes: true });
    expect(first.in + last.in).toBe(25_500_00);
  });

  it('acepta lo recibido real y valida el saldo', () => {
    expect(splitTransferPayment(1_000_00, 25_000_00, 100_00, 2_480_00)).toEqual({ out: 100_00, in: 2_480_00, closes: false });
    expect(() => splitTransferPayment(1_000_00, 1_000_00, 1_000_01)).toThrow('supera');
    expect(() => splitTransferPayment(1_000_00, 1_000_00, 0)).toThrow();
    expect(() => splitTransferPayment(1_000_00, 25_000_00, 100_00, 25_000_00)).toThrow('no cuadra');
  });
});
