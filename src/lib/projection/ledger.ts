import type { ISODate } from '@/lib/dates';
import type { Cents } from '@/lib/money';
import { CurrencyConverter } from './currency';
import type { HistoryMovementKind } from './history';
import type { EngineEntity, EngineRate } from './types';

/**
 * Libro real (lo que ya pasó) para las columnas pasadas de la Matriz de flujo. Función pura.
 *
 * Agrupa los cobros/pagos reales de las cuentas líquidas en filas (una por partida o por
 * recurrencia, una por tarjeta pagada, una por transferencia entre entidades) y devuelve el
 * cambio diario TOTAL de caja (incluye aperturas, ajustes y traspasos internos) para que la
 * Matriz reconstruya los saldos hacia atrás a partir de la caja de hoy.
 *
 * Misma regla que el historial: aperturas, traspasos entre cuentas de la misma entidad y ajustes
 * no son flujo; en el consolidado, las transferencias entre entidades se netean (no son flujo).
 */

export interface LedgerMovement {
  entityId: string;
  date: ISODate;
  /** Con signo: + entra, − sale. En la moneda de la entidad. */
  amount: Cents;
  kind: HistoryMovementKind;
  /** Agrupador de la fila (p. ej. `rule:<id>`, `ob:<id>`, `card:<id>`, `tr:<id>`). */
  groupKey: string;
  label: string;
  recurring?: boolean;
}

export interface LedgerInput {
  today: ISODate;
  from: ISODate;
  entities: EngineEntity[];
  rates: EngineRate[];
  outputCurrency: string;
  consolidated: boolean;
  dataStart: ISODate | null;
  movements: LedgerMovement[];
}

export type LedgerRowKind = 'OBLIGATION' | 'CARD_PAYMENT' | 'TRANSFER';

export interface LedgerRow {
  key: string;
  direction: 'IN' | 'OUT';
  entityId: string;
  kind: LedgerRowKind;
  description: string;
  recurring: boolean;
  /** Montos positivos en la moneda de salida, por fecha (ordenados). */
  entries: { date: ISODate; amount: Cents }[];
  total: Cents;
}

export interface LedgerResult {
  currency: string;
  from: ISODate;
  to: ISODate;
  dataStart: ISODate | null;
  rows: LedgerRow[];
  /** Cambio total de caja por fecha (todo movimiento), en la moneda de salida. */
  changes: { date: ISODate; amount: Cents }[];
  missingRates: string[];
}

export function buildLedger(input: LedgerInput): LedgerResult {
  const { today, from, outputCurrency, consolidated } = input;
  const conv = new CurrencyConverter(input.rates, today);
  const entities = new Map(input.entities.map((e) => [e.id, e]));

  const changes = new Map<ISODate, Cents>();
  const rows = new Map<string, LedgerRow>();

  for (const m of input.movements) {
    if (m.date < from || m.date > today) continue;
    const e = entities.get(m.entityId);
    if (!e) continue;
    const amount = conv.convert(m.amount, e.currency, outputCurrency);
    if (amount === null) continue;
    changes.set(m.date, (changes.get(m.date) ?? 0) + amount);

    if (m.kind === 'OPENING' || m.kind === 'ACCOUNT_TRANSFER' || m.kind === 'ADJUSTMENT') continue;
    if (m.kind === 'TRANSFER' && consolidated) continue;
    if (amount === 0) continue;

    const direction = amount > 0 ? 'IN' : 'OUT';
    const key = `${direction}|${m.entityId}|${m.groupKey}`;
    const row =
      rows.get(key) ??
      ({
        key,
        direction,
        entityId: m.entityId,
        kind: m.kind === 'CARD_PAYMENT' ? 'CARD_PAYMENT' : m.kind === 'TRANSFER' ? 'TRANSFER' : 'OBLIGATION',
        description: m.label,
        recurring: Boolean(m.recurring),
        entries: [],
        total: 0,
      } satisfies LedgerRow);
    const abs = Math.abs(amount);
    const same = row.entries.find((x) => x.date === m.date);
    if (same) same.amount += abs;
    else row.entries.push({ date: m.date, amount: abs });
    row.total += abs;
    rows.set(key, row);
  }

  const sortedRows = Array.from(rows.values());
  for (const r of sortedRows) r.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // Por fecha del primer movimiento y luego por descripción
  sortedRows.sort((a, b) => {
    const da = a.entries[0]?.date ?? '';
    const db = b.entries[0]?.date ?? '';
    return da === db ? a.description.localeCompare(b.description) : da < db ? -1 : 1;
  });

  return {
    currency: outputCurrency,
    from,
    to: today,
    dataStart: input.dataStart,
    rows: sortedRows,
    changes: Array.from(changes.entries())
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    missingRates: Array.from(conv.missing),
  };
}

/** Suma de los cambios de caja con fecha en [from, to] (inclusive). */
export function sumChanges(changes: LedgerResult['changes'], from: ISODate, to: ISODate): Cents {
  let s = 0;
  for (const c of changes) if (c.date >= from && c.date <= to) s += c.amount;
  return s;
}

/** Suma de las entradas de una fila con fecha en [from, to] (inclusive). */
export function sumEntries(row: LedgerRow, from: ISODate, to: ISODate): Cents {
  let s = 0;
  for (const e of row.entries) if (e.date >= from && e.date <= to) s += e.amount;
  return s;
}
