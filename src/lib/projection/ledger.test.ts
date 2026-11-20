import { describe, expect, it } from 'vitest';
import { buildLedger, sumChanges, sumEntries, type LedgerInput, type LedgerMovement } from './ledger';
import type { EngineEntity } from './types';

const TODAY = '2026-11-19';
const A: EngineEntity = { id: 'A', name: 'Base', color: '#10b981', currency: 'HNL', minCashThreshold: 0 };
const B: EngineEntity = { id: 'B', name: 'USD Co', color: '#6366f1', currency: 'USD', minCashThreshold: 0 };

function mv(p: Partial<LedgerMovement> & { date: string; amount: number }): LedgerMovement {
  return { entityId: 'A', kind: 'PAYMENT', groupKey: 'ob:1', label: 'Partida', ...p };
}

function input(p: Partial<LedgerInput> = {}): LedgerInput {
  return {
    today: TODAY,
    from: '2026-08-17',
    entities: [A, B],
    rates: [{ fromCurrency: 'USD', toCurrency: 'HNL', rate: 25, effectiveDate: '2026-01-01' }],
    outputCurrency: 'HNL',
    consolidated: false,
    dataStart: '2026-01-01',
    movements: [],
    ...p,
  };
}

describe('libro real para la matriz', () => {
  it('agrupa por partida/recurrencia y dirección, sumando por fecha', () => {
    const r = buildLedger(
      input({
        movements: [
          mv({ date: '2026-09-01', amount: 1_000_00, groupKey: 'rule:r1', label: 'Iguala', recurring: true }),
          mv({ date: '2026-10-01', amount: 1_000_00, groupKey: 'rule:r1', label: 'Iguala', recurring: true }),
          mv({ date: '2026-10-01', amount: 500_00, groupKey: 'rule:r1', label: 'Iguala', recurring: true }),
          mv({ date: '2026-09-05', amount: -300_00, groupKey: 'ob:x', label: 'Alquiler' }),
        ],
      }),
    );
    expect(r.rows).toHaveLength(2);
    const iguala = r.rows.find((x) => x.description === 'Iguala')!;
    expect(iguala).toMatchObject({ direction: 'IN', recurring: true, total: 2_500_00 });
    expect(iguala.entries).toEqual([
      { date: '2026-09-01', amount: 1_000_00 },
      { date: '2026-10-01', amount: 1_500_00 },
    ]);
    expect(r.rows.find((x) => x.description === 'Alquiler')).toMatchObject({ direction: 'OUT', total: 300_00 });
    expect(sumEntries(iguala, '2026-10-01', '2026-10-31')).toBe(1_500_00);
  });

  it('aperturas, ajustes y traspasos internos mueven la caja pero no generan filas', () => {
    const r = buildLedger(
      input({
        movements: [
          mv({ date: '2026-09-01', amount: 10_000_00, kind: 'OPENING' }),
          mv({ date: '2026-09-02', amount: -50_00, kind: 'ADJUSTMENT' }),
          mv({ date: '2026-09-03', amount: -1_000_00, kind: 'ACCOUNT_TRANSFER' }),
          mv({ date: '2026-09-03', amount: 1_000_00, kind: 'ACCOUNT_TRANSFER' }),
        ],
      }),
    );
    expect(r.rows).toHaveLength(0);
    expect(sumChanges(r.changes, '2026-09-01', '2026-09-30')).toBe(9_950_00);
  });

  it('transferencias entre entidades: fila en una entidad, neteadas en el consolidado', () => {
    const moves = [
      mv({ date: '2026-09-10', amount: -2_500_00, kind: 'TRANSFER', groupKey: 'tr:t1', label: 'Préstamo → B' }),
      mv({ entityId: 'B', date: '2026-09-10', amount: 100_00, kind: 'TRANSFER', groupKey: 'tr:t1', label: 'Préstamo ← A' }),
    ];
    const single = buildLedger(input({ movements: moves.slice(0, 1) }));
    expect(single.rows[0]).toMatchObject({ kind: 'TRANSFER', direction: 'OUT', total: 2_500_00 });
    const cons = buildLedger(input({ consolidated: true, movements: moves }));
    expect(cons.rows).toHaveLength(0);
    // 100 USD × 25 = 2,500 HNL: se netea a cero
    expect(sumChanges(cons.changes, '2026-09-10', '2026-09-10')).toBe(0);
  });

  it('ignora movimientos fuera de la ventana [from, hoy] y convierte moneda', () => {
    const r = buildLedger(
      input({
        movements: [
          mv({ date: '2026-08-16', amount: 1_00 }),
          mv({ date: '2026-11-20', amount: 1_00 }),
          mv({ entityId: 'B', date: TODAY, amount: 10_00, groupKey: 'ob:b', label: 'USD' }),
        ],
      }),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ entityId: 'B', total: 250_00 });
    expect(r.changes).toEqual([{ date: TODAY, amount: 250_00 }]);
  });

  it('pagos de tarjeta salen como fila propia', () => {
    const r = buildLedger(input({ movements: [mv({ date: '2026-10-05', amount: -800_00, kind: 'CARD_PAYMENT', groupKey: 'card:c1', label: 'Pago tarjeta Visa' })] }));
    expect(r.rows[0]).toMatchObject({ kind: 'CARD_PAYMENT', description: 'Pago tarjeta Visa', direction: 'OUT' });
  });
});
