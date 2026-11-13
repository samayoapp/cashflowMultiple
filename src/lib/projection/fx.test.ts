import { describe, expect, it } from 'vitest';
import { convertCents, convertPair, effectiveSellRate, fxDifference, parseAmountWithCurrency, rate4, rateToString } from './fx';

describe('tasas a 4 decimales', () => {
  it('parsea y redondea half-up', () => {
    expect(rate4('26.9872')).toBe(269872);
    expect(rate4('26.98718')).toBe(269872);
    expect(rate4('26.98715')).toBe(269872);
    expect(rate4('26.98714')).toBe(269871);
    expect(rate4(26.987182)).toBe(269872);
    expect(rate4('27')).toBe(270000);
    expect(rateToString(269872)).toBe('26.9872');
    expect(rateToString(270005)).toBe('27.0005');
  });

  it('venta efectiva = oficial + spread (0.18 por defecto)', () => {
    expect(rateToString(effectiveSellRate(rate4('26.9872'), rate4('0.18')))).toBe('27.1672');
  });
});

describe('conversión sin floats', () => {
  it('USD -> HNL con redondeo a centavos', () => {
    expect(convertCents(100_00, rate4('27.1672'), 'mul')).toBe(2716_72);
    expect(convertCents(1, rate4('27.1672'), 'mul')).toBe(27); // 0.271672 -> 0.27
    expect(convertCents(33_33, rate4('27.1672'), 'mul')).toBe(905_48); // 905.482776
    expect(convertCents(-100_00, rate4('27.1672'), 'mul')).toBe(-2716_72);
    // montos grandes sin pérdida de precisión
    expect(convertCents(9_999_999_999_99, rate4('27.1672'), 'mul')).toBe(271_671_999_999_73);
  });

  it('HNL -> USD', () => {
    expect(convertCents(2716_72, rate4('27.1672'), 'div')).toBe(100_00);
    expect(convertPair(500_00, 'HNL', 'USD', rate4('25'))).toBe(20_00);
    expect(convertPair(500_00, 'HNL', 'HNL', rate4('25'))).toBe(500_00);
  });
});

describe('detección de moneda en texto', () => {
  it.each([
    ['$ 1,200.50', 120050, 'USD'],
    ['USD 80', 8000, 'USD'],
    ['80 usd', 8000, 'USD'],
    ['US$45', 4500, 'USD'],
    ['L. 3,000', 300000, 'HNL'],
    ['L 300.25', 30025, 'HNL'],
    ['Lps. 25', 2500, 'HNL'],
    ['HNL 50', 5000, 'HNL'],
    ['1500 lempiras', 150000, 'HNL'],
    ['1,250.00', 125000, null],
  ])('%s', (text, cents, currency) => {
    expect(parseAmountWithCurrency(text)).toEqual({ cents, currency });
  });

  it('rechaza textos sin monto', () => {
    expect(parseAmountWithCurrency('sin monto')).toBeNull();
    expect(parseAmountWithCurrency('$ 0')).toBeNull();
    expect(parseAmountWithCurrency(12.5)).toEqual({ cents: 1250, currency: null });
  });
});

describe('diferencial cambiario', () => {
  it('pérdida cuando la tasa real del pago es mayor a la del consumo', () => {
    // $100 comprados a 27.00, pagados a 27.20 => L. 20.00 de pérdida
    const bank = convertCents(100_00, rate4('27.20'), 'mul');
    expect(fxDifference([{ amount: 100_00, rateAtTx: rate4('27.00') }], bank, rate4('27.20'), 100_00)).toBe(20_00);
  });

  it('ganancia cuando la tasa baja; lo no asignado no genera diferencial', () => {
    const bank = convertCents(150_00, rate4('26.50'), 'mul');
    expect(fxDifference([{ amount: 100_00, rateAtTx: rate4('27.00') }], bank, rate4('26.50'), 150_00)).toBe(-50_00);
  });
});
