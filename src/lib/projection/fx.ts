import { toCents, type Cents } from '@/lib/money';

/**
 * Tipo de cambio como entero en diezmilésimas (4 decimales): 27.1672 -> 271672.
 * Toda conversión usa BigInt con redondeo half-up a centavos (sin errores de float).
 */
export type Rate4 = number;

/** "27.1672" | 27.16725 | Prisma.Decimal -> 271673 (redondeo half-up a 4 decimales) */
export function rate4(v: string | number | { toString(): string }): Rate4 {
  const s = typeof v === 'number' ? v.toFixed(6) : v.toString().trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Tasa inválida: ${s}`);
  const [int, frac = ''] = s.split('.');
  const frac5 = (frac + '00000').slice(0, 5);
  let r = BigInt(int) * 10000n + BigInt(frac5.slice(0, 4));
  if (Number(frac5[4]) >= 5) r += 1n;
  return Number(r);
}

/** 271672 -> "27.1672" */
export function rateToString(r: Rate4): string {
  return `${Math.floor(r / 10000)}.${String(r % 10000).padStart(4, '0')}`;
}

function divRound(num: bigint, den: bigint): bigint {
  const neg = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = (a * 2n + b) / (b * 2n); // half-up sobre el valor absoluto
  return neg ? -q : q;
}

/**
 * Convierte centavos con una tasa de 4 decimales.
 *  - 'mul': moneda extranjera -> local (USD × 27.1672 = HNL)
 *  - 'div': local -> extranjera (HNL ÷ 27.1672 = USD)
 */
export function convertCents(amount: Cents, rate: Rate4, mode: 'mul' | 'div'): Cents {
  if (!(rate > 0)) throw new Error('Tasa inválida');
  const a = BigInt(Math.round(amount));
  const r = BigInt(rate);
  return Number(mode === 'mul' ? divRound(a * r, 10000n) : divRound(a * 10000n, r));
}

/** Convierte de `from` a `to` para el par HNL/USD, donde `sellRate` es USD→HNL. */
export function convertPair(amount: Cents, from: string, to: string, sellRate: Rate4): Cents {
  if (from === to) return amount;
  if (from === 'USD' && to === 'HNL') return convertCents(amount, sellRate, 'mul');
  if (from === 'HNL' && to === 'USD') return convertCents(amount, sellRate, 'div');
  throw new Error(`Par de monedas no soportado: ${from}→${to}`);
}

/** Tasa de venta efectiva = oficial + spread bancario. */
export function effectiveSellRate(official: Rate4, spread: Rate4): Rate4 {
  return official + spread;
}

/**
 * Detecta monto y moneda en texto libre: "$ 1,200.50", "USD 80", "80 usd", "L. 3,000", "L 300", "HNL 50", "Lps. 25".
 * Devuelve currency = null si no hay indicio de moneda.
 */
export function parseAmountWithCurrency(input: string | number | null | undefined): { cents: Cents; currency: 'HNL' | 'USD' | null } | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    try {
      const c = toCents(input);
      return c > 0 ? { cents: c, currency: null } : null;
    } catch {
      return null;
    }
  }
  const raw = input.trim();
  let currency: 'HNL' | 'USD' | null = null;
  if (/\$|\busd\b|\bus\$|\bdólares?\b|\bdolares?\b/i.test(raw)) currency = 'USD';
  else if (/\bhnl\b|\blps?\.?(?=\s|\d|$)|\blempiras?\b|(^|\s)l\.?\s*(?=\d)/i.test(raw)) currency = 'HNL';
  const m = raw.match(/-?\d[\d,]*(\.\d+)?/);
  if (!m) return null;
  try {
    const c = toCents(m[0].replace(/,/g, ''));
    return c > 0 ? { cents: c, currency } : null;
  } catch {
    return null;
  }
}

/**
 * Diferencial cambiario de un pago en moneda extranjera:
 * lo que realmente salió del banco − valor de esas cuotas a la tasa del día de cada compra.
 * `toBase(monto, tasa)` convierte la moneda extranjera a la local (p. ej. USD × tasa).
 * Positivo = pérdida cambiaria; negativo = ganancia.
 */
export function fxDifference(
  allocations: { amount: Cents; rateAtTx: Rate4 }[],
  bankAmount: Cents,
  paidRate: Rate4,
  paidForeign: Cents,
  toBase: (amount: Cents, rate: Rate4) => Cents = (amount, rate) => convertCents(amount, rate, 'mul'),
): Cents {
  let booked = 0;
  let allocated = 0;
  for (const a of allocations) {
    booked += toBase(a.amount, a.rateAtTx);
    allocated += a.amount;
  }
  // La parte no asignada a cuotas (intereses, ajustes) se valúa a la tasa del pago: sin diferencial
  const rest = paidForeign - allocated;
  if (rest > 0) booked += toBase(rest, paidRate);
  return bankAmount - booked;
}
