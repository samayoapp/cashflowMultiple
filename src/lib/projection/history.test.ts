import { describe, expect, it } from 'vitest';
import { buildHistory, historyStart, type HistoryInput, type HistoryMovement } from './history';
import type { EngineEntity } from './types';

const TODAY = '2026-11-19'; // jueves; semana en curso inicia lun 2026-11-16
const A: EngineEntity = { id: 'A', name: 'Base', color: '#10b981', currency: 'HNL', minCashThreshold: 0 };
const B: EngineEntity = { id: 'B', name: 'USD Co', color: '#6366f1', currency: 'USD', minCashThreshold: 0 };

function mv(p: Partial<HistoryMovement> & { date: string; amount: number }): HistoryMovement {
  return { entityId: 'A', kind: 'PAYMENT', categoryName: null, ...p };
}

function input(p: Partial<HistoryInput> = {}): HistoryInput {
  return {
    today: TODAY,
    entities: [A],
    rates: [{ fromCurrency: 'USD', toCurrency: 'HNL', rate: 25, effectiveDate: '2026-01-01' }],
    outputCurrency: 'HNL',
    consolidated: false,
    balancesBefore: [{ entityId: 'A', balance: 10_000_00 }],
    dataStart: '2025-01-01',
    movements: [],
    ...p,
  };
}

describe('historial real', () => {
  it('ventana de 13 semanas completas que termina el domingo anterior a la semana en curso', () => {
    const r = buildHistory(input());
    expect(historyStart(TODAY)).toBe('2026-08-17');
    expect(r.start).toBe('2026-08-17');
    expect(r.end).toBe('2026-11-15');
    expect(r.weeks).toHaveLength(13);
    expect(r.weeks[0].index).toBe(-13);
    expect(r.weeks[12]).toMatchObject({ index: -1, start: '2026-11-09', end: '2026-11-15' });
  });

  it('arrastra el saldo semana a semana y separa entradas, salidas y categorías', () => {
    const r = buildHistory(
      input({
        movements: [
          mv({ date: '2026-08-18', amount: 5_000_00, categoryName: 'Ventas' }),
          mv({ date: '2026-08-20', amount: -2_000_00, categoryName: 'Planilla' }),
          mv({ date: '2026-08-25', amount: -1_000_00, kind: 'CARD_PAYMENT' }),
          mv({ date: '2026-08-26', amount: -300_00, categoryName: 'Planilla' }),
        ],
      }),
    );
    expect(r.weeks[0]).toMatchObject({ opening: 10_000_00, inflows: 5_000_00, outflows: 2_000_00, net: 3_000_00, closing: 13_000_00 });
    expect(r.weeks[1]).toMatchObject({ opening: 13_000_00, outflows: 1_300_00, closing: 11_700_00 });
    expect(r.weeks[12].closing).toBe(11_700_00);
    expect(r.totals).toMatchObject({ inflows: 5_000_00, outflows: 3_300_00, net: 1_700_00, weeksWithData: 13 });
    expect(r.byCategory).toEqual([
      { direction: 'IN', name: 'Ventas', amount: 5_000_00 },
      { direction: 'OUT', name: 'Planilla', amount: 2_300_00 },
      { direction: 'OUT', name: 'Pagos de tarjeta', amount: 1_000_00 },
    ]);
  });

  it('aperturas, transferencias internas y ajustes mueven el saldo pero no son flujo', () => {
    const r = buildHistory(
      input({
        balancesBefore: [],
        dataStart: '2026-09-01',
        movements: [
          mv({ date: '2026-09-01', amount: 20_000_00, kind: 'OPENING' }),
          mv({ date: '2026-09-02', amount: -4_000_00, kind: 'ACCOUNT_TRANSFER' }),
          mv({ date: '2026-09-02', amount: 4_000_00, kind: 'ACCOUNT_TRANSFER' }),
          mv({ date: '2026-09-03', amount: -150_00, kind: 'ADJUSTMENT' }),
        ],
      }),
    );
    const w = r.weeks.find((x) => x.start === '2026-08-31')!;
    expect(w).toMatchObject({ inflows: 0, outflows: 0, adjustments: -150_00, opening: 0, closing: 19_850_00 });
    expect(r.totals.adjustments).toBe(-150_00);
    expect(r.byCategory).toEqual([]);
  });

  it('marca sin datos las semanas anteriores a la primera apertura y promedia solo las que tienen', () => {
    const r = buildHistory(
      input({
        balancesBefore: [],
        dataStart: '2026-10-28', // miércoles de la semana -3
        movements: [
          mv({ date: '2026-10-28', amount: 1_000_00, kind: 'OPENING' }),
          mv({ date: '2026-11-03', amount: 3_000_00 }),
        ],
      }),
    );
    expect(r.weeks.filter((w) => w.hasData).map((w) => w.index)).toEqual([-3, -2, -1]);
    expect(r.totals.weeksWithData).toBe(3);
    expect(r.totals.avgWeeklyIn).toBe(1_000_00);
  });

  it('sin historia: todas las semanas sin datos', () => {
    const r = buildHistory(input({ dataStart: null, balancesBefore: [] }));
    expect(r.weeks.every((w) => !w.hasData)).toBe(true);
    expect(r.totals.avgWeeklyIn).toBe(0);
  });

  it('consolidado: convierte a la moneda de reporte y netea transferencias entre entidades', () => {
    const r = buildHistory(
      input({
        entities: [A, B],
        consolidated: true,
        balancesBefore: [
          { entityId: 'A', balance: 1_000_00 },
          { entityId: 'B', balance: 100_00 },
        ],
        movements: [
          mv({ entityId: 'B', date: '2026-11-10', amount: 40_00, categoryName: 'Ventas' }),
          mv({ entityId: 'A', date: '2026-11-10', amount: -500_00, kind: 'TRANSFER' }),
          mv({ entityId: 'B', date: '2026-11-10', amount: 20_00, kind: 'TRANSFER' }),
        ],
      }),
    );
    const last = r.weeks[12];
    expect(r.weeks[0].opening).toBe(3_500_00);
    expect(last).toMatchObject({ inflows: 1_000_00, outflows: 0 });
    expect(last.byEntity.B).toEqual({ inflows: 1_000_00, outflows: 0 });
    // el saldo sí refleja las transferencias (aquí no cuadran a propósito: 500 vs 20×25)
    expect(last.closing).toBe(3_500_00 + 1_000_00 - 500_00 + 500_00);
  });

  it('por entidad: las transferencias entre entidades sí son flujo', () => {
    const r = buildHistory(input({ movements: [mv({ date: '2026-11-10', amount: -500_00, kind: 'TRANSFER' })] }));
    expect(r.weeks[12].outflows).toBe(500_00);
    expect(r.byCategory[0]).toEqual({ direction: 'OUT', name: 'Transferencias entre entidades', amount: 500_00 });
  });

  it('ignora movimientos fuera de la ventana (los de la semana en curso los cubre la proyección)', () => {
    const r = buildHistory(input({ movements: [mv({ date: '2026-11-17', amount: 9_00 }), mv({ date: '2026-08-16', amount: 9_00 })] }));
    expect(r.totals.inflows).toBe(0);
  });
});
