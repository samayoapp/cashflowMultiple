/**
 * Dinero como centavos enteros (number) en todo el motor y la UI.
 * En la base se guarda NUMERIC(18,2); las APIs viajan como string "1234.56".
 * Los enteros son exactos hasta 9e15 centavos, muy por encima de cualquier saldo real.
 */
export type Cents = number;

export const SUPPORTED_CURRENCIES = ['HNL', 'USD', 'EUR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number] | string;

/** "1234.56" | 1234.56 | Prisma.Decimal -> 123456 */
export function toCents(v: string | number | { toString(): string } | null | undefined): Cents {
  if (v === null || v === undefined) return 0;
  const s = typeof v === 'number' ? v.toFixed(2) : v.toString().trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Monto inválido: ${s}`);
  const neg = s.startsWith('-');
  const [int, frac = ''] = s.replace('-', '').split('.');
  // Redondeo half-up al segundo decimal
  const frac3 = (frac + '000').slice(0, 3);
  let cents = BigInt(int) * 100n + BigInt(frac3.slice(0, 2));
  if (Number(frac3[2]) >= 5) cents += 1n;
  const n = Number(cents);
  return neg ? -n : n;
}

/** 123456 -> "1234.56" (para APIs y Prisma) */
export function centsToDecimalString(c: Cents): string {
  const neg = c < 0;
  const abs = Math.abs(Math.round(c));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

const formatterCache = new Map<string, Intl.NumberFormat>();

export function formatMoney(c: Cents, currency: string, opts: { compact?: boolean } = {}): string {
  const key = `${currency}|${opts.compact ? 'c' : 'f'}`;
  let f = formatterCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('es-HN', {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
      notation: opts.compact ? 'compact' : 'standard',
      minimumFractionDigits: opts.compact ? 0 : 2,
      maximumFractionDigits: opts.compact ? 1 : 2,
    });
    formatterCache.set(key, f);
  }
  return f.format(c / 100);
}

export const sum = (xs: Cents[]): Cents => xs.reduce((a, b) => a + b, 0);
