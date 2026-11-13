import type { ISODate } from '@/lib/dates';
import type { Cents } from '@/lib/money';
import type { EngineRate } from './types';

/**
 * Conversor de monedas para la vista consolidada.
 * Usa la tasa vigente más reciente (effectiveDate <= hoy). Busca directa, inversa
 * y, si no hay, cruzada vía cualquier moneda intermedia común.
 * Nunca se usa para alterar saldos de cuentas: solo para presentar totales.
 */
export class CurrencyConverter {
  private latest = new Map<string, number>();
  readonly missing = new Set<string>();

  constructor(rates: EngineRate[], today: ISODate) {
    const best = new Map<string, EngineRate>();
    for (const r of rates) {
      if (r.effectiveDate > today || !(r.rate > 0)) continue;
      const k = `${r.fromCurrency}>${r.toCurrency}`;
      const cur = best.get(k);
      if (!cur || r.effectiveDate > cur.effectiveDate) best.set(k, r);
    }
    best.forEach((r, k) => this.latest.set(k, r.rate));
  }

  rate(from: string, to: string): number | null {
    if (from === to) return 1;
    const direct = this.latest.get(`${from}>${to}`);
    if (direct) return direct;
    const inverse = this.latest.get(`${to}>${from}`);
    if (inverse) return 1 / inverse;
    // Cruce vía una moneda intermedia
    const currencies = new Set<string>();
    this.latest.forEach((_, k) => k.split('>').forEach((c) => currencies.add(c)));
    for (const mid of Array.from(currencies)) {
      if (mid === from || mid === to) continue;
      const a = this.directOrInverse(from, mid);
      const b = this.directOrInverse(mid, to);
      if (a && b) return a * b;
    }
    return null;
  }

  private directOrInverse(from: string, to: string): number | null {
    const d = this.latest.get(`${from}>${to}`);
    if (d) return d;
    const i = this.latest.get(`${to}>${from}`);
    return i ? 1 / i : null;
  }

  /** Convierte centavos; devuelve null (y registra el par) si falta la tasa. */
  convert(amount: Cents, from: string, to: string): Cents | null {
    const r = this.rate(from, to);
    if (r === null) {
      this.missing.add(`${from}→${to}`);
      return null;
    }
    return Math.round(amount * r);
  }
}
