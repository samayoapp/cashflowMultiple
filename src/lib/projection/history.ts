import { addDays, diffDays, startOfWeek, type ISODate } from '@/lib/dates';
import type { Cents } from '@/lib/money';
import { CurrencyConverter } from './currency';
import type { EngineEntity, EngineRate } from './types';

/**
 * Historial REAL de caja (lo que ya pasó), semana a semana, para las N semanas
 * anteriores a la semana en curso. Función pura, igual que el motor de proyección.
 *
 * Solo cuentas líquidas (bancos, caja, billeteras): las tarjetas no son caja.
 *  - Saldo de cierre = apertura + todos los movimientos hasta el fin de la semana.
 *  - Entradas / salidas = cobros, pagos, pagos de tarjeta y transferencias entre entidades.
 *    No cuentan: aperturas, transferencias entre cuentas de la misma entidad (no cambian la caja)
 *    ni, en el consolidado, las transferencias entre entidades (se netean).
 *  - Ajustes de conciliación: mueven el saldo pero se reportan aparte (no son flujo operativo).
 *  - Antes de la primera apertura no hay historia: esas semanas salen con hasData = false.
 */

export type HistoryMovementKind =
  | 'OPENING'
  | 'PAYMENT'
  | 'ADJUSTMENT'
  | 'TRANSFER' // entre entidades
  | 'ACCOUNT_TRANSFER' // entre cuentas de la misma entidad
  | 'CARD_PAYMENT';

export interface HistoryMovement {
  entityId: string;
  date: ISODate;
  /** Con signo: + entra, − sale. En la moneda de la entidad. */
  amount: Cents;
  kind: HistoryMovementKind;
  /** Categoría de la partida (solo cobros/pagos). */
  categoryName?: string | null;
}

export interface HistoryInput {
  today: ISODate;
  weeks?: number;
  entities: EngineEntity[];
  rates: EngineRate[];
  outputCurrency: string;
  consolidated: boolean;
  /** Saldo de cada entidad ANTES del inicio del historial (suma de movimientos previos). */
  balancesBefore: { entityId: string; balance: Cents }[];
  /** Fecha del primer movimiento (normalmente la apertura) en las cuentas líquidas; null = sin datos. */
  dataStart: ISODate | null;
  /** Movimientos de cuentas líquidas dentro de la ventana del historial. */
  movements: HistoryMovement[];
}

export interface HistoryWeek {
  /** −N … −1 (−1 = semana pasada). */
  index: number;
  start: ISODate;
  end: ISODate;
  hasData: boolean;
  opening: Cents;
  inflows: Cents;
  outflows: Cents;
  adjustments: Cents;
  net: Cents;
  closing: Cents;
  byEntity: Record<string, { inflows: Cents; outflows: Cents }>;
}

export interface HistoryCategory {
  direction: 'IN' | 'OUT';
  name: string;
  amount: Cents;
}

export interface HistoryResult {
  currency: string;
  consolidated: boolean;
  start: ISODate;
  end: ISODate;
  dataStart: ISODate | null;
  weeks: HistoryWeek[];
  totals: {
    inflows: Cents;
    outflows: Cents;
    adjustments: Cents;
    net: Cents;
    /** Promedios semanales sobre las semanas con datos. */
    avgWeeklyIn: Cents;
    avgWeeklyOut: Cents;
    weeksWithData: number;
  };
  byCategory: HistoryCategory[];
  missingRates: string[];
}

const CARD_PAYMENTS = 'Pagos de tarjeta';
const INTER_ENTITY = 'Transferencias entre entidades';
const UNCATEGORIZED = 'Sin categoría';

/** Primer día de la ventana del historial (lunes, N semanas antes de la semana en curso). */
export function historyStart(today: ISODate, weeks = 13): ISODate {
  return addDays(startOfWeek(today), -weeks * 7);
}

export function buildHistory(input: HistoryInput): HistoryResult {
  const weeksCount = input.weeks ?? 13;
  const { today, outputCurrency, consolidated, dataStart } = input;
  const start = historyStart(today, weeksCount);
  const end = addDays(startOfWeek(today), -1);

  const conv = new CurrencyConverter(input.rates, today);
  const entities = new Map(input.entities.map((e) => [e.id, e]));
  const toOut = (amount: Cents, entityId: string): Cents | null => {
    const e = entities.get(entityId);
    return e ? conv.convert(amount, e.currency, outputCurrency) : null;
  };

  let opening = 0;
  for (const b of input.balancesBefore) opening += toOut(b.balance, b.entityId) ?? 0;

  const weeks: HistoryWeek[] = [];
  for (let i = 0; i < weeksCount; i++) {
    const ws = addDays(start, i * 7);
    const we = addDays(ws, 6);
    weeks.push({
      index: i - weeksCount,
      start: ws,
      end: we,
      hasData: dataStart !== null && dataStart <= we,
      opening: 0,
      inflows: 0,
      outflows: 0,
      adjustments: 0,
      net: 0,
      closing: 0,
      byEntity: {},
    });
  }

  const change: Cents[] = weeks.map(() => 0);
  const cats = new Map<string, HistoryCategory>();
  const addCat = (direction: 'IN' | 'OUT', name: string, amount: Cents) => {
    const k = `${direction}|${name}`;
    const c = cats.get(k) ?? { direction, name, amount: 0 };
    c.amount += amount;
    cats.set(k, c);
  };

  for (const m of input.movements) {
    if (m.date < start || m.date > end) continue;
    const wi = Math.floor(diffDays(m.date, start) / 7);
    const w = weeks[wi];
    const amount = toOut(m.amount, m.entityId);
    if (amount === null || !w) continue;
    // Todo movimiento (incluso aperturas y transferencias) mueve el saldo de la semana
    change[wi] += amount;
    if (m.kind === 'OPENING' || m.kind === 'ACCOUNT_TRANSFER') continue;
    if (m.kind === 'TRANSFER' && consolidated) continue;
    if (m.kind === 'ADJUSTMENT') {
      w.adjustments += amount;
      continue;
    }
    const dir = amount >= 0 ? 'IN' : 'OUT';
    const abs = Math.abs(amount);
    const f = (w.byEntity[m.entityId] ??= { inflows: 0, outflows: 0 });
    if (dir === 'IN') {
      w.inflows += abs;
      f.inflows += abs;
    } else {
      w.outflows += abs;
      f.outflows += abs;
    }
    const name =
      m.kind === 'CARD_PAYMENT' ? CARD_PAYMENTS : m.kind === 'TRANSFER' ? INTER_ENTITY : (m.categoryName ?? UNCATEGORIZED);
    addCat(dir, name, abs);
  }

  let running = opening;
  weeks.forEach((w, i) => {
    w.opening = running;
    w.closing = running + change[i];
    w.net = w.inflows - w.outflows;
    running = w.closing;
  });

  const withData = weeks.filter((w) => w.hasData);
  const sum = (f: (w: HistoryWeek) => number) => weeks.reduce((s, w) => s + f(w), 0);
  const inflows = sum((w) => w.inflows);
  const outflows = sum((w) => w.outflows);
  const n = withData.length;

  return {
    currency: outputCurrency,
    consolidated,
    start,
    end,
    dataStart,
    weeks,
    totals: {
      inflows,
      outflows,
      adjustments: sum((w) => w.adjustments),
      net: inflows - outflows,
      avgWeeklyIn: n ? Math.round(inflows / n) : 0,
      avgWeeklyOut: n ? Math.round(outflows / n) : 0,
      weeksWithData: n,
    },
    byCategory: Array.from(cats.values()).sort((a, b) => b.amount - a.amount),
    missingRates: Array.from(conv.missing),
  };
}
