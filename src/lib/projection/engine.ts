import { addDays, diffDays, startOfWeek } from '@/lib/dates';
import type { Cents } from '@/lib/money';
import { CurrencyConverter } from './currency';
import { expandRule } from './recurrence';
import type {
  DailyPoint,
  EngineEntity,
  EngineOverride,
  EntityBreakdown,
  ProjectedItem,
  ProjectionInput,
  ProjectionResult,
  WeekBucket,
} from './types';

/**
 * Motor de proyección de liquidez. Función pura: mismo input => mismo output.
 * Se ejecuta en el servidor (API) y en el cliente (recalculo instantáneo en la matriz).
 *
 * Reglas de negocio:
 *  - Se proyecta con la Fecha Esperada (expectedDate), nunca con la de vencimiento.
 *  - Pendientes con Fecha Esperada < hoy se arrastran a HOY con overdue = true.
 *  - Pendiente = monto - abonos. Las liquidadas/canceladas no proyectan.
 *  - Vista consolidada: se excluye todo lo que tenga transferId (neteo inter-entidad)
 *    y los montos se convierten a la moneda de reporte.
 *  - What-If apagado: se ignoran hipotéticas y overrides.
 *  - Recurrencias: ocurrencias virtuales desde hoy; las ya materializadas
 *    (Obligation con recurrenceId + occurrenceDate) reemplazan a la virtual.
 *  - Tarjetas de crédito (cuenta puente): su saldo NO suma a la caja real; las cuotas
 *    pendientes salen como un solo "Pago Tarjeta" en su fecha límite de pago.
 */
export function project(input: ProjectionInput): ProjectionResult {
  const weeksCount = input.weeks ?? 13;
  const daysCount = input.days ?? 90;
  const { today, outputCurrency, consolidated, whatIf } = input;

  const conv = new CurrencyConverter(input.rates, today);
  const entities = new Map<string, EngineEntity>(input.entities.map((e) => [e.id, e]));
  const toOut = (amount: Cents, entityId: string): Cents | null => {
    const e = entities.get(entityId);
    if (!e) return null;
    return conv.convert(amount, e.currency, outputCurrency);
  };

  const week0 = startOfWeek(today);
  const weeksEnd = addDays(week0, weeksCount * 7 - 1);
  const daysEnd = addDays(today, daysCount - 1);
  const horizonEnd = weeksEnd > daysEnd ? weeksEnd : daysEnd;

  const overrides = new Map<string, EngineOverride>();
  if (whatIf) for (const o of input.overrides) overrides.set(o.obligationId, o);

  const weekIndexOf = (date: string): number | null => {
    const idx = Math.floor(diffDays(date, week0) / 7);
    return idx >= 0 && idx < weeksCount ? idx : null;
  };

  const items: ProjectedItem[] = [];
  const materialized = new Set<string>();

  // 1. Obligaciones (CxC / CxP / transferencias planificadas)
  for (const ob of input.obligations) {
    if (ob.recurrenceId && ob.occurrenceDate) materialized.add(`${ob.recurrenceId}|${ob.occurrenceDate}`);
    const entity = entities.get(ob.entityId);
    if (!entity) continue;
    if (ob.status === 'SETTLED' || ob.status === 'CANCELLED') continue;
    if (consolidated && ob.transferId) continue;
    if (ob.isHypothetical && !whatIf) continue;

    const ov = overrides.get(ob.id);
    if (ov?.excluded) continue;

    let remaining = ob.amount - ob.paid;
    if (ov && ov.amount !== null) remaining = ov.amount;
    if (remaining <= 0) continue;

    const expectedDate = ov?.expectedDate ?? ob.expectedDate;
    const overdue = expectedDate < today;
    const date = overdue ? today : expectedDate;
    if (date > horizonEnd) continue;

    const amount = toOut(remaining, ob.entityId);
    if (amount === null) continue;

    items.push({
      key: ob.id,
      source: 'OBLIGATION',
      obligationId: ob.id,
      ruleId: ob.recurrenceId,
      entityId: ob.entityId,
      direction: ob.direction,
      description: ob.description,
      counterpartyName: ob.counterpartyName ?? null,
      categoryName: ob.categoryName ?? null,
      amount,
      amountNative: remaining,
      nativeCurrency: entity.currency,
      date,
      expectedDate,
      dueDate: ob.dueDate,
      overdue,
      priority: ob.priority,
      isHypothetical: ob.isHypothetical,
      simulated: Boolean(ov && (ov.amount !== null || ov.expectedDate !== null)),
      transferId: ob.transferId,
      status: ob.status,
      weekIndex: weekIndexOf(date),
    });
  }

  // 2. Recurrencias virtuales (desde hoy)
  for (const rule of input.rules) {
    const entity = entities.get(rule.entityId);
    if (!entity) continue;
    for (const date of expandRule(rule, today, horizonEnd)) {
      if (materialized.has(`${rule.id}|${date}`)) continue;
      const amount = toOut(rule.amount, rule.entityId);
      if (amount === null) continue;
      items.push({
        key: `rule:${rule.id}:${date}`,
        source: 'RECURRENCE',
        obligationId: null,
        ruleId: rule.id,
        entityId: rule.entityId,
        direction: rule.direction,
        description: rule.description,
        counterpartyName: rule.counterpartyName ?? null,
        categoryName: rule.categoryName ?? null,
        amount,
        amountNative: rule.amount,
        nativeCurrency: entity.currency,
        date,
        expectedDate: date,
        dueDate: date,
        overdue: false,
        priority: rule.priority,
        isHypothetical: false,
        simulated: false,
        transferId: null,
        status: 'PROJECTED',
        weekIndex: weekIndexOf(date),
      });
    }
  }

  // 3. Estados de cuenta de tarjetas: cuotas pendientes agrupadas por (tarjeta, fecha límite)
  const statements = new Map<string, ProjectedItem>();
  for (const ci of input.cardInstallments ?? []) {
    const entity = entities.get(ci.entityId);
    if (!entity) continue;
    const pending = ci.amount - ci.settled;
    if (pending <= 0) continue;
    const overdue = ci.dueDate < today;
    const date = overdue ? today : ci.dueDate;
    if (date > horizonEnd) continue;
    const key = `card:${ci.cardAccountId}:${ci.dueDate}`;
    let st = statements.get(key);
    if (!st) {
      st = {
        key,
        source: 'CARD_STATEMENT',
        obligationId: null,
        ruleId: null,
        entityId: ci.entityId,
        direction: 'OUT',
        description: `Pago Tarjeta: ${ci.cardName}`,
        counterpartyName: null,
        categoryName: null,
        amount: 0,
        amountNative: 0,
        nativeCurrency: entity.currency,
        date,
        expectedDate: ci.dueDate,
        dueDate: ci.dueDate,
        overdue,
        priority: 'FIXED',
        isHypothetical: false,
        simulated: false,
        transferId: null,
        status: 'OPEN',
        weekIndex: weekIndexOf(date),
        cardAccountId: ci.cardAccountId,
        cardDetails: [],
      };
      statements.set(key, st);
    }
    st.amountNative += pending;
    st.cardDetails!.push({
      installmentId: ci.id,
      chargeId: ci.chargeId,
      description: ci.description,
      categoryName: ci.categoryName ?? null,
      counterpartyName: ci.counterpartyName ?? null,
      purchaseDate: ci.purchaseDate,
      number: ci.number,
      count: ci.count,
      pendingNative: pending,
    });
  }
  statements.forEach((st) => {
    // Se convierte el total del estado (no cada cuota) para no acumular redondeos
    const amount = toOut(st.amountNative, st.entityId);
    if (amount === null) return;
    st.amount = amount;
    st.cardDetails!.sort((a, b) => (a.purchaseDate === b.purchaseDate ? a.number - b.number : a.purchaseDate < b.purchaseDate ? -1 : 1));
    items.push(st);
  });

  items.sort((a, b) =>
    a.date === b.date ? (a.direction === b.direction ? b.amount - a.amount : a.direction === 'IN' ? -1 : 1) : a.date < b.date ? -1 : 1,
  );

  // 4. Caja real hoy (solo cuentas líquidas) y deuda flotante en tarjetas
  const cashByEntity = new Map<string, Cents>();
  const debtByEntity = new Map<string, Cents>();
  for (const b of input.balances) {
    if (!entities.has(b.entityId)) continue;
    const v = toOut(b.balance, b.entityId);
    if (v === null) continue;
    if (b.kind === 'CREDIT_CARD') {
      // saldo negativo = deuda; un saldo a favor no se cuenta como caja
      if (v < 0) debtByEntity.set(b.entityId, (debtByEntity.get(b.entityId) ?? 0) - v);
      continue;
    }
    cashByEntity.set(b.entityId, (cashByEntity.get(b.entityId) ?? 0) + v);
  }
  let cashToday = 0;
  cashByEntity.forEach((v) => (cashToday += v));
  let cardDebt = 0;
  debtByEntity.forEach((v) => (cardDebt += v));

  // 5. Buckets semanales
  const weeks: WeekBucket[] = [];
  let running = cashToday;
  for (let i = 0; i < weeksCount; i++) {
    const start = addDays(week0, i * 7);
    weeks.push({
      index: i,
      start,
      end: addDays(start, 6),
      opening: 0,
      inflows: 0,
      outflows: 0,
      net: 0,
      closing: 0,
      byEntity: {},
    });
  }
  for (const it of items) {
    if (it.weekIndex === null) continue;
    const w = weeks[it.weekIndex];
    const flow = (w.byEntity[it.entityId] ??= { inflows: 0, outflows: 0 });
    if (it.direction === 'IN') {
      w.inflows += it.amount;
      flow.inflows += it.amount;
    } else {
      w.outflows += it.amount;
      flow.outflows += it.amount;
    }
  }
  for (const w of weeks) {
    w.opening = running;
    w.net = w.inflows - w.outflows;
    w.closing = running + w.net;
    running = w.closing;
  }

  // 6. Serie diaria (hoy .. hoy + días - 1)
  const dayIndex = new Map<string, { inflows: Cents; outflows: Cents }>();
  for (const it of items) {
    if (it.date > daysEnd) continue;
    const d = dayIndex.get(it.date) ?? { inflows: 0, outflows: 0 };
    if (it.direction === 'IN') d.inflows += it.amount;
    else d.outflows += it.amount;
    dayIndex.set(it.date, d);
  }
  const daily: DailyPoint[] = [];
  let bal = cashToday;
  let lowPoint = { date: today, balance: Number.POSITIVE_INFINITY };
  let outflowsWindow = 0;
  for (let i = 0; i < daysCount; i++) {
    const date = addDays(today, i);
    const d = dayIndex.get(date) ?? { inflows: 0, outflows: 0 };
    bal += d.inflows - d.outflows;
    outflowsWindow += d.outflows;
    daily.push({ date, inflows: d.inflows, outflows: d.outflows, balance: bal });
    if (bal < lowPoint.balance) lowPoint = { date, balance: bal };
  }
  if (!Number.isFinite(lowPoint.balance)) lowPoint = { date: today, balance: cashToday };

  // 7. KPIs
  const in30End = addDays(today, 29);
  let inflows30 = 0;
  let outflows30 = 0;
  for (const it of items) {
    if (it.date > in30End) continue;
    if (it.direction === 'IN') inflows30 += it.amount;
    else outflows30 += it.amount;
  }

  let threshold = 0;
  input.entities.forEach((e) => {
    const t = conv.convert(e.minCashThreshold, e.currency, outputCurrency);
    if (t !== null) threshold += t;
  });

  // Runway = caja ÷ (salidas de la ventana ÷ días), en enteros para evitar errores de float
  const runwayDays =
    cashToday <= 0 ? 0 : outflowsWindow > 0 ? Math.floor((cashToday * daysCount) / outflowsWindow) : null;

  // 8. Desglose por entidad
  const byEntity: EntityBreakdown[] = input.entities.map((e) => {
    let inflows13w = 0;
    let outflows13w = 0;
    for (const w of weeks) {
      const f = w.byEntity[e.id];
      if (f) {
        inflows13w += f.inflows;
        outflows13w += f.outflows;
      }
    }
    return {
      entityId: e.id,
      cash: cashByEntity.get(e.id) ?? 0,
      cardDebt: debtByEntity.get(e.id) ?? 0,
      inflows13w,
      outflows13w,
    };
  });

  return {
    today,
    currency: outputCurrency,
    consolidated,
    whatIf,
    items,
    weeks,
    daily,
    byEntity,
    kpis: {
      cashToday,
      cardDebt,
      net30: inflows30 - outflows30,
      inflows30,
      outflows30,
      runwayDays,
      lowPoint,
      threshold,
      lowPointBelowZero: lowPoint.balance < 0,
      lowPointBelowThreshold: lowPoint.balance < threshold,
    },
    missingRates: Array.from(conv.missing),
  };
}
