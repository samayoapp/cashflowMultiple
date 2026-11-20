import type { Cents } from '@/lib/money';

/**
 * Totales de una tabla "como Excel": suma lo que se está viendo (las filas ya filtradas).
 * Función pura, en centavos enteros.
 *
 * - Cada columna sumable devuelve, por fila, un monto con su moneda (o varios: tarjetas bimoneda),
 *   o null si esa fila no aporta a la columna.
 * - Nunca se suman monedas distintas: hay un total por moneda.
 * - `section` separa lo que no tiene sentido sumar junto (p. ej. ingresos vs. gastos);
 *   devolver null excluye la fila (p. ej. canceladas).
 */
export interface Amount {
  amount: Cents;
  currency: string;
}

export type ColumnValue<T> = (row: T) => Amount | Amount[] | null | undefined;

export interface TotalsRow {
  /** Sección (null = una sola). */
  section: string | null;
  currency: string;
  /** Filas de la sección que aportan (se repite en cada moneda de la sección). */
  count: number;
  /** Suma por columna sumable, en el orden recibido; null si esa columna no tiene montos en esta moneda. */
  sums: (Cents | null)[];
}

export function tableTotals<T>(
  rows: readonly T[],
  columns: readonly ColumnValue<T>[],
  section: (row: T) => string | null | false = () => null,
): TotalsRow[] {
  const sections = new Map<string | null, { count: number; byCurrency: Map<string, (Cents | null)[]> }>();
  for (const row of rows) {
    const key = section(row);
    if (key === false) continue;
    let s = sections.get(key);
    if (!s) {
      s = { count: 0, byCurrency: new Map() };
      sections.set(key, s);
    }
    s.count++;
    columns.forEach((col, i) => {
      const v = col(row);
      const list = v == null ? [] : Array.isArray(v) ? v : [v];
      for (const { amount, currency } of list) {
        let sums = s!.byCurrency.get(currency);
        if (!sums) {
          sums = columns.map(() => null);
          s!.byCurrency.set(currency, sums);
        }
        sums[i] = (sums[i] ?? 0) + amount;
      }
    });
  }
  const out: TotalsRow[] = [];
  for (const [key, s] of sections) {
    if (s.byCurrency.size === 0) {
      out.push({ section: key, currency: '', count: s.count, sums: columns.map(() => null) });
      continue;
    }
    for (const [currency, sums] of s.byCurrency) out.push({ section: key, currency, count: s.count, sums });
  }
  return out;
}
