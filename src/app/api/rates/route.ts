import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, ok, readJson, route } from '@/lib/server/api';
import { requireAdmin, requireUser } from '@/lib/server/auth';
import { dbDate, isoOf } from '@/lib/server/serialize';
import { currency, isoDate } from '@/lib/validation';
import { effectiveSellRate, rate4, rateToString } from '@/lib/projection/fx';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  await requireUser();
  const rows = await prisma.exchangeRate.findMany({
    orderBy: [{ effectiveDate: 'desc' }, { fromCurrency: 'asc' }],
    take: 500,
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      fromCurrency: r.fromCurrency,
      toCurrency: r.toCurrency,
      rate: r.rate.toString(),
      effectiveDate: isoOf(r.effectiveDate),
      officialSellRate: r.officialSellRate ? Number(r.officialSellRate.toString()).toFixed(4) : null,
      bankSpread: r.bankSpread ? Number(r.bankSpread.toString()).toFixed(4) : null,
      effectiveSellRate: r.effectiveSellRate ? Number(r.effectiveSellRate.toString()).toFixed(4) : null,
      source: r.source,
    })),
  );
});

const schema = z.object({
  fromCurrency: currency,
  toCurrency: currency,
  rate: z.union([z.string(), z.number()]).transform((v, ctx) => {
    const s = String(v).trim();
    if (!/^\d+(\.\d{1,6})?$/.test(s) || Number(s) <= 0) {
      ctx.addIssue({ code: 'custom', message: 'Tasa inválida (positiva, hasta 6 decimales)' });
      return z.NEVER;
    }
    return s;
  }),
  effectiveDate: isoDate,
});

/** Crea o actualiza la tasa de un par para una fecha. Solo afecta la vista consolidada. */
export const POST = route(async (req) => {
  await requireAdmin();
  const data = schema.parse(await readJson(req));
  if (data.fromCurrency === data.toCurrency) throw badRequest('Las monedas deben ser distintas');
  // USD→HNL es además la tasa de las tarjetas: se guarda como oficial manual + spread global
  let usdHnl = {};
  if (data.fromCurrency === 'USD' && data.toCurrency === 'HNL') {
    const settings = await prisma.appSetting.findUnique({ where: { id: 1 }, select: { fxBankSpread: true } });
    const official = rate4(data.rate);
    const spread = settings ? rate4(settings.fxBankSpread) : 1800;
    usdHnl = {
      officialBuyRate: rateToString(official),
      officialSellRate: rateToString(official),
      bankSpread: rateToString(spread),
      effectiveSellRate: rateToString(effectiveSellRate(official, spread)),
      source: 'MANUAL',
    };
  }
  const r = await prisma.exchangeRate.upsert({
    where: {
      fromCurrency_toCurrency_effectiveDate: {
        fromCurrency: data.fromCurrency,
        toCurrency: data.toCurrency,
        effectiveDate: dbDate(data.effectiveDate),
      },
    },
    update: { rate: data.rate, ...usdHnl },
    create: {
      fromCurrency: data.fromCurrency,
      toCurrency: data.toCurrency,
      rate: data.rate,
      effectiveDate: dbDate(data.effectiveDate),
      ...usdHnl,
    },
  });
  return ok({ id: r.id }, { status: 201 });
});
