import { describe, expect, it } from 'vitest';
import { tableTotals } from './totals';

interface Row {
  amount: number;
  paid: number;
  cur: string;
  dir: 'IN' | 'OUT';
  cancelled?: boolean;
}

const rows: Row[] = [
  { amount: 100_00, paid: 40_00, cur: 'HNL', dir: 'IN' },
  { amount: 250_50, paid: 0, cur: 'HNL', dir: 'IN' },
  { amount: 10_00, paid: 10_00, cur: 'USD', dir: 'IN' },
  { amount: 999_00, paid: 0, cur: 'HNL', dir: 'IN', cancelled: true },
];
const amount = (r: Row) => ({ amount: r.amount, currency: r.cur });
const paid = (r: Row) => ({ amount: r.paid, currency: r.cur });

describe('totales de tabla', () => {
  it('suma por columna y por moneda, sin mezclar monedas', () => {
    expect(tableTotals(rows.slice(0, 3), [amount, paid])).toEqual([
      { section: null, currency: 'HNL', count: 3, sums: [350_50, 40_00] },
      { section: null, currency: 'USD', count: 3, sums: [10_00, 10_00] },
    ]);
  });

  it('excluye filas cuando la sección es false (p. ej. canceladas)', () => {
    const t = tableTotals(rows, [amount], (r) => (r.cancelled ? false : null));
    expect(t).toEqual([
      { section: null, currency: 'HNL', count: 3, sums: [350_50] },
      { section: null, currency: 'USD', count: 3, sums: [10_00] },
    ]);
  });

  it('separa secciones (ingresos y gastos no se suman juntos)', () => {
    const mixed: Row[] = [...rows.slice(0, 2), { amount: 30_00, paid: 0, cur: 'HNL', dir: 'OUT' }];
    const t = tableTotals(mixed, [amount], (r) => (r.dir === 'IN' ? 'Ingresos' : 'Gastos'));
    expect(t).toEqual([
      { section: 'Ingresos', currency: 'HNL', count: 2, sums: [350_50] },
      { section: 'Gastos', currency: 'HNL', count: 1, sums: [30_00] },
    ]);
  });

  it('una columna sin montos en una moneda queda en null; admite varios montos por fila (bimoneda)', () => {
    const t = tableTotals(
      [{ base: 500_00, foreign: 20_00 }, { base: 100_00, foreign: 0 }],
      [(r) => [{ amount: r.base, currency: 'HNL' }, ...(r.foreign ? [{ amount: r.foreign, currency: 'USD' }] : [])], () => null],
    );
    expect(t).toEqual([
      { section: null, currency: 'HNL', count: 2, sums: [600_00, null] },
      { section: null, currency: 'USD', count: 2, sums: [20_00, null] },
    ]);
  });

  it('sin filas no hay totales', () => {
    expect(tableTotals([], [amount])).toEqual([]);
  });
});
