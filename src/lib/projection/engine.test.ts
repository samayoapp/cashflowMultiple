import { describe, expect, it } from 'vitest';
import { netFlowWithin, project } from './engine';
import { expandRule } from './recurrence';
import { CurrencyConverter } from './currency';
import type { EngineCardInstallment, EngineEntity, EngineObligation, EngineRule, ProjectionInput } from './types';
import { centsToDecimalString, toCents } from '@/lib/money';
import { addMonths, startOfWeek } from '@/lib/dates';

const TODAY = '2026-11-12'; // jueves

const A: EngineEntity = { id: 'A', name: 'Base', color: '#10b981', currency: 'HNL', minCashThreshold: 10_000_00 };
const B: EngineEntity = { id: 'B', name: 'USD Co', color: '#6366f1', currency: 'USD', minCashThreshold: 0 };

function ob(p: Partial<EngineObligation> & { id: string }): EngineObligation {
  return {
    entityId: 'A',
    direction: 'IN',
    description: p.id,
    amount: 1000_00,
    paid: 0,
    dueDate: TODAY,
    expectedDate: TODAY,
    status: 'OPEN',
    priority: 'FLEXIBLE',
    isHypothetical: false,
    transferId: null,
    recurrenceId: null,
    occurrenceDate: null,
    ...p,
  };
}

function input(p: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    today: TODAY,
    entities: [A],
    balances: [{ accountId: 'acc1', entityId: 'A', balance: 50_000_00 }],
    obligations: [],
    rules: [],
    overrides: [],
    rates: [{ fromCurrency: 'USD', toCurrency: 'HNL', rate: 25, effectiveDate: '2026-01-01' }],
    outputCurrency: 'HNL',
    consolidated: false,
    whatIf: false,
    ...p,
  };
}

describe('money', () => {
  it('convierte strings decimales a centavos sin errores de float', () => {
    expect(toCents('0.1')).toBe(10);
    expect(toCents('1234.565')).toBe(123457);
    expect(toCents('-20.05')).toBe(-2005);
    expect(centsToDecimalString(-2005)).toBe('-20.05');
    expect(centsToDecimalString(5)).toBe('0.05');
  });
});

describe('fechas', () => {
  it('semana inicia lunes y meses respetan fin de mes', () => {
    expect(startOfWeek('2026-11-12')).toBe('2026-11-09');
    expect(startOfWeek('2026-11-15')).toBe('2026-11-09'); // domingo
    expect(addMonths('2026-01-31', 1, 31)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 2, 31)).toBe('2026-03-31');
  });
});

describe('proyección: doble fecha y vencidos', () => {
  it('proyecta por Fecha Esperada, no por vencimiento', () => {
    const r = project(
      input({ obligations: [ob({ id: 'x', dueDate: '2026-11-13', expectedDate: '2026-12-10' })] }),
    );
    const it0 = r.items[0];
    expect(it0.date).toBe('2026-12-10');
    expect(it0.weekIndex).toBe(4);
    expect(r.weeks[0].inflows).toBe(0);
    expect(r.weeks[4].inflows).toBe(1000_00);
  });

  it('arrastra pendientes vencidos a hoy y los marca', () => {
    const r = project(input({ obligations: [ob({ id: 'late', expectedDate: '2026-10-01', direction: 'OUT' })] }));
    expect(r.items[0].overdue).toBe(true);
    expect(r.items[0].date).toBe(TODAY);
    expect(r.items[0].expectedDate).toBe('2026-10-01');
    expect(r.weeks[0].outflows).toBe(1000_00);
  });

  it('no proyecta partidas liquidadas ni canceladas', () => {
    const r = project(
      input({
        obligations: [
          ob({ id: 's', status: 'SETTLED', paid: 1000_00 }),
          ob({ id: 'c', status: 'CANCELLED' }),
        ],
      }),
    );
    expect(r.items).toHaveLength(0);
  });
});

describe('proyección: abonos parciales', () => {
  it('proyecta solo el saldo pendiente', () => {
    const r = project(input({ obligations: [ob({ id: 'p', amount: 1000_00, paid: 400_00, status: 'PARTIAL' })] }));
    expect(r.items[0].amount).toBe(600_00);
    expect(r.kpis.cashToday).toBe(50_000_00);
    expect(r.weeks[0].closing).toBe(50_600_00);
  });
});

describe('proyección: saldos, KPIs y punto bajo', () => {
  it('calcula flujo neto 30 días, runway y cash low point', () => {
    const r = project(
      input({
        balances: [{ accountId: 'a', entityId: 'A', balance: 20_000_00 }],
        obligations: [
          ob({ id: 'pay', direction: 'OUT', amount: 30_000_00, expectedDate: '2026-11-20', priority: 'FIXED' }),
          ob({ id: 'col', direction: 'IN', amount: 15_000_00, expectedDate: '2026-11-25' }),
          ob({ id: 'far', direction: 'IN', amount: 5_000_00, expectedDate: '2027-01-20' }),
        ],
      }),
    );
    expect(r.kpis.cashToday).toBe(20_000_00);
    expect(r.kpis.net30).toBe(-15_000_00);
    expect(r.kpis.lowPoint).toEqual({ date: '2026-11-20', balance: -10_000_00 });
    expect(r.kpis.lowPointBelowZero).toBe(true);
    expect(r.kpis.lowPointBelowThreshold).toBe(true);
    // 30,000 de salidas en 90 días => 333.33/día => 60 días
    expect(r.kpis.runwayDays).toBe(60);
    expect(r.weeks[12].closing).toBe(10_000_00);
  });

  it('runway ilimitado sin salidas', () => {
    expect(project(input()).kpis.runwayDays).toBeNull();
  });
});

describe('proyección: transferencias inter-entidad', () => {
  const transfer = [
    ob({ id: 't-out', entityId: 'A', direction: 'OUT', amount: 2500_00, expectedDate: '2026-11-18', transferId: 'T1' }),
    ob({ id: 't-in', entityId: 'B', direction: 'IN', amount: 100_00, expectedDate: '2026-11-18', transferId: 'T1' }),
  ];

  it('aparecen en cada entidad individual', () => {
    const rA = project(input({ obligations: transfer }));
    expect(rA.weeks[1].outflows).toBe(2500_00);
    const rB = project(
      input({ entities: [B], balances: [], obligations: transfer, outputCurrency: 'USD' }),
    );
    expect(rB.weeks[1].inflows).toBe(100_00);
  });

  it('se netean en la vista consolidada', () => {
    const r = project(
      input({ entities: [A, B], obligations: transfer, consolidated: true }),
    );
    expect(r.items).toHaveLength(0);
    expect(r.weeks[1].inflows).toBe(0);
    expect(r.weeks[1].outflows).toBe(0);
  });
});

describe('proyección: multi-moneda', () => {
  it('consolida en moneda de reporte sin alterar el saldo nativo', () => {
    const r = project(
      input({
        entities: [A, B],
        consolidated: true,
        balances: [
          { accountId: 'a', entityId: 'A', balance: 1000_00 },
          { accountId: 'b', entityId: 'B', balance: 100_00 },
        ],
        obligations: [ob({ id: 'usd', entityId: 'B', amount: 10_00, expectedDate: '2026-11-13' })],
      }),
    );
    expect(r.kpis.cashToday).toBe(1000_00 + 2500_00);
    expect(r.items[0].amount).toBe(250_00);
    expect(r.items[0].amountNative).toBe(10_00);
    expect(r.byEntity.find((e) => e.entityId === 'B')?.cash).toBe(2500_00);
  });

  it('usa la tasa vigente más reciente, la inversa y cruces', () => {
    const c = new CurrencyConverter(
      [
        { fromCurrency: 'USD', toCurrency: 'HNL', rate: 24, effectiveDate: '2026-01-01' },
        { fromCurrency: 'USD', toCurrency: 'HNL', rate: 25, effectiveDate: '2026-06-01' },
        { fromCurrency: 'USD', toCurrency: 'HNL', rate: 99, effectiveDate: '2027-01-01' }, // futura
        { fromCurrency: 'EUR', toCurrency: 'USD', rate: 1.1, effectiveDate: '2026-01-01' },
      ],
      TODAY,
    );
    expect(c.convert(100, 'USD', 'HNL')).toBe(2500);
    expect(c.convert(2500, 'HNL', 'USD')).toBe(100);
    expect(c.convert(100, 'EUR', 'HNL')).toBe(2750);
  });

  it('reporta pares sin tasa', () => {
    const r = project(
      input({
        entities: [A, { ...B, currency: 'GBP' }],
        consolidated: true,
        balances: [{ accountId: 'b', entityId: 'B', balance: 100 }],
      }),
    );
    expect(r.missingRates).toContain('GBP→HNL');
  });
});

describe('proyección: What-If', () => {
  const real = ob({ id: 'r', direction: 'IN', amount: 5000_00, expectedDate: '2026-11-13' });
  const hypo = ob({ id: 'h', direction: 'OUT', amount: 8000_00, expectedDate: '2026-11-20', isHypothetical: true });
  const overrides = [{ obligationId: 'r', expectedDate: '2026-12-15', amount: null, excluded: false }];

  it('apagado: ignora hipotéticas y overrides', () => {
    const r = project(input({ obligations: [real, hypo], overrides }));
    expect(r.items.map((i) => i.key)).toEqual(['r']);
    expect(r.items[0].date).toBe('2026-11-13');
  });

  it('encendido: aplica overrides e hipotéticas sin mutar el registro real', () => {
    const r = project(input({ obligations: [real, hypo], overrides, whatIf: true }));
    const moved = r.items.find((i) => i.key === 'r')!;
    expect(moved.date).toBe('2026-12-15');
    expect(moved.simulated).toBe(true);
    expect(r.items.find((i) => i.key === 'h')).toBeTruthy();
    expect(real.expectedDate).toBe('2026-11-13');
  });

  it('encendido: excluye partidas apagadas', () => {
    const r = project(
      input({
        obligations: [real],
        overrides: [{ obligationId: 'r', expectedDate: null, amount: null, excluded: true }],
        whatIf: true,
      }),
    );
    expect(r.items).toHaveLength(0);
  });
});

describe('recurrencias', () => {
  const rule: EngineRule = {
    id: 'R',
    entityId: 'A',
    direction: 'OUT',
    description: 'Planilla',
    amount: 1000_00,
    frequency: 'BIWEEKLY',
    startDate: '2026-10-30',
    endDate: null,
    priority: 'FIXED',
    active: true,
  };

  it('expande ocurrencias en el rango', () => {
    expect(expandRule(rule, '2026-11-12', '2026-12-31')).toEqual([
      '2026-11-13',
      '2026-11-27',
      '2026-12-11',
      '2026-12-25',
    ]);
    expect(
      expandRule({ ...rule, frequency: 'MONTHLY', startDate: '2026-01-31' }, '2026-11-01', '2027-02-28'),
    ).toEqual(['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
  });

  it('una ocurrencia materializada reemplaza a la virtual', () => {
    const r = project(
      input({
        rules: [rule],
        obligations: [
          ob({
            id: 'mat',
            direction: 'OUT',
            recurrenceId: 'R',
            occurrenceDate: '2026-11-13',
            status: 'SETTLED',
            paid: 1000_00,
          }),
        ],
      }),
    );
    expect(r.items.find((i) => i.date === '2026-11-13')).toBeUndefined();
    expect(r.items.filter((i) => i.source === 'RECURRENCE').length).toBeGreaterThan(0);
  });

  it('una recurrencia hipotética solo se proyecta en Modo Simulación', () => {
    const hypo = { ...rule, isHypothetical: true };
    const real = project(input({ rules: [hypo] }));
    expect(real.items.filter((i) => i.source === 'RECURRENCE')).toHaveLength(0);
    const sim = project(input({ rules: [hypo], whatIf: true }));
    const items = sim.items.filter((i) => i.source === 'RECURRENCE');
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.isHypothetical)).toBe(true);
    // Una recurrencia real sigue proyectándose como no hipotética en ambos modos
    expect(project(input({ rules: [rule], whatIf: true })).items.filter((i) => i.source === 'RECURRENCE').every((i) => !i.isHypothetical)).toBe(true);
  });

  it('respeta endDate y reglas inactivas', () => {
    expect(expandRule({ ...rule, endDate: '2026-11-20' }, '2026-11-12', '2026-12-31')).toEqual(['2026-11-13']);
    expect(expandRule({ ...rule, active: false }, '2026-11-12', '2026-12-31')).toEqual([]);
  });
});

describe('tarjetas de crédito (cuenta puente)', () => {
  const inst = (p: Partial<EngineCardInstallment> & { id: string }): EngineCardInstallment => ({
    chargeId: 'ch-' + p.id,
    entityId: 'A',
    cardAccountId: 'visa',
    cardName: 'Visa',
    description: p.id,
    purchaseDate: '2026-11-01',
    number: 1,
    count: 1,
    amount: 1000_00,
    settled: 0,
    statementDate: '2026-11-15',
    dueDate: '2026-12-05',
    ...p,
  });

  it('el saldo de la tarjeta no suma a la caja real y se reporta como deuda flotante', () => {
    const r = project(
      input({
        balances: [
          { accountId: 'acc1', entityId: 'A', balance: 50_000_00 },
          { accountId: 'visa', entityId: 'A', balance: -3_000_00, kind: 'CREDIT_CARD' },
        ],
      }),
    );
    expect(r.kpis.cashToday).toBe(50_000_00);
    expect(r.kpis.cardDebt).toBe(3_000_00);
    expect(r.byEntity[0]).toMatchObject({ cash: 50_000_00, cardDebt: 3_000_00 });
  });

  it('agrupa las cuotas pendientes en un solo pago en la fecha límite', () => {
    const r = project(
      input({
        cardInstallments: [
          inst({ id: 'software', amount: 1000_00, categoryName: 'Software' }),
          inst({ id: 'combustible', amount: 500_00, settled: 200_00 }),
          inst({ id: 'cuota2', number: 2, count: 6, dueDate: '2027-01-05' }),
          inst({ id: 'pagada', amount: 400_00, settled: 400_00 }),
        ],
      }),
    );
    const cards = r.items.filter((i) => i.source === 'CARD_STATEMENT');
    expect(cards).toHaveLength(2);
    const dec = cards.find((c) => c.dueDate === '2026-12-05')!;
    expect(dec).toMatchObject({ description: 'Pago Tarjeta: Visa', amount: 1300_00, direction: 'OUT', date: '2026-12-05' });
    expect(dec.cardDetails!.map((d) => d.pendingNative)).toEqual([1000_00, 300_00]);
    expect(dec.cardDetails![0].categoryName).toBe('Software');
    // La compra no afecta la caja de hoy: el desfase se ve en la semana del pago
    expect(r.kpis.cashToday).toBe(50_000_00);
    expect(r.weeks[dec.weekIndex!].outflows).toBe(1300_00);
    expect(r.weeks[0].outflows).toBe(0);
  });

  it('un estado de cuenta vencido se arrastra a hoy', () => {
    const r = project(input({ cardInstallments: [inst({ id: 'v', dueDate: '2026-11-05' })] }));
    const it0 = r.items.find((i) => i.source === 'CARD_STATEMENT')!;
    expect(it0).toMatchObject({ date: TODAY, overdue: true, dueDate: '2026-11-05' });
  });

  it('se incluye en la vista consolidada y se convierte a la moneda de reporte', () => {
    const r = project(
      input({
        entities: [A, B],
        consolidated: true,
        cardInstallments: [inst({ id: 'usd', entityId: 'B', amount: 100_00 })],
      }),
    );
    const it0 = r.items.find((i) => i.source === 'CARD_STATEMENT')!;
    expect(it0.amount).toBe(2500_00);
    expect(it0.amountNative).toBe(100_00);
  });
});

describe('tarjetas bimoneda (HNL / USD)', () => {
  const R = 271672; // 27.1672 = 26.9872 oficial + 0.18 spread
  const ci = (p: Partial<EngineCardInstallment> & { id: string }): EngineCardInstallment => ({
    chargeId: 'ch-' + p.id,
    entityId: 'A',
    cardAccountId: 'visa',
    cardName: 'Visa',
    description: p.id,
    purchaseDate: '2026-11-01',
    number: 1,
    count: 1,
    amount: 1000_00,
    settled: 0,
    statementDate: '2026-11-15',
    dueDate: '2026-12-05',
    currency: 'HNL',
    fxRate4: R,
    ...p,
  });

  it('salida proyectada = saldo HNL + saldo USD × tasa de venta efectiva', () => {
    const r = project(
      input({
        cardInstallments: [
          ci({ id: 'insumos', amount: 2000_00 }),
          ci({ id: 'aws', amount: 60_00, currency: 'USD' }),
          ci({ id: 'adobe', amount: 40_00, currency: 'USD', number: 1, count: 3 }),
        ],
      }),
    );
    const st = r.items.find((i) => i.source === 'CARD_STATEMENT')!;
    // 2000 + 100 × 27.1672 = 4716.72
    expect(st.amount).toBe(4716_72);
    expect(st.cardBreakdown).toEqual({ base: 2000_00, foreign: 100_00, foreignCurrency: 'USD', rate4: R });
    expect(st.cardDetails!.find((d) => d.description === 'aws')).toMatchObject({ currency: 'USD', pendingNative: 60_00 });
  });

  it('un cambio de tasa recalcula la salida', () => {
    const base = input({ cardInstallments: [ci({ id: 'aws', amount: 100_00, currency: 'USD' })] });
    const a = project(base).items.find((i) => i.source === 'CARD_STATEMENT')!;
    const b = project({ ...base, cardInstallments: [ci({ id: 'aws', amount: 100_00, currency: 'USD', fxRate4: 275000 })] }).items.find(
      (i) => i.source === 'CARD_STATEMENT',
    )!;
    expect(a.amount).toBe(2716_72);
    expect(b.amount).toBe(2750_00);
  });

  it('deuda flotante convierte el sub-saldo en dólares; la caja no cambia', () => {
    const r = project(
      input({
        balances: [
          { accountId: 'acc1', entityId: 'A', balance: 50_000_00 },
          { accountId: 'visa', entityId: 'A', balance: -1000_00, kind: 'CREDIT_CARD' },
          { accountId: 'visa', entityId: 'A', balance: -200_00, kind: 'CREDIT_CARD', currency: 'USD', fxRate4: R },
        ],
      }),
    );
    expect(r.kpis.cashToday).toBe(50_000_00);
    expect(r.kpis.cardDebt).toBe(1000_00 + 5433_44); // 200 × 27.1672 = 5433.44
  });

  it('sin tasa de tarjeta usa la del consolidado (USD→HNL 25)', () => {
    const r = project(input({ cardInstallments: [ci({ id: 'x', amount: 10_00, currency: 'USD', fxRate4: null })] }));
    expect(r.items.find((i) => i.source === 'CARD_STATEMENT')!.amount).toBe(250_00);
  });
});

describe('flujo neto por período', () => {
  it('30 / 60 / 90 días acumulan solo lo que cae en cada ventana', () => {
    const r = project(
      input({
        obligations: [
          ob({ id: 'c1', direction: 'IN', amount: 10_000_00, expectedDate: '2026-11-20' }),
          ob({ id: 'p1', direction: 'OUT', amount: 4_000_00, expectedDate: '2026-12-11' }), // día 30 (último de la ventana)
          ob({ id: 'p2', direction: 'OUT', amount: 3_000_00, expectedDate: '2026-12-12' }), // día 31
          ob({ id: 'c2', direction: 'IN', amount: 2_000_00, expectedDate: '2027-01-10' }), // día 60
          ob({ id: 'p3', direction: 'OUT', amount: 1_000_00, expectedDate: '2027-02-09' }), // día 90
          ob({ id: 'p4', direction: 'OUT', amount: 9_000_00, expectedDate: '2027-02-10' }), // día 91: fuera
        ],
      }),
    );
    expect(netFlowWithin(r.items, TODAY, 30)).toEqual({ inflows: 10_000_00, outflows: 4_000_00, net: 6_000_00, end: '2026-12-11' });
    expect(netFlowWithin(r.items, TODAY, 60).net).toBe(10_000_00 + 2_000_00 - 7_000_00);
    expect(netFlowWithin(r.items, TODAY, 90).net).toBe(12_000_00 - 8_000_00);
    expect([r.kpis.inflows30, r.kpis.outflows30, r.kpis.net30]).toEqual([10_000_00, 4_000_00, 6_000_00]);
  });
});
