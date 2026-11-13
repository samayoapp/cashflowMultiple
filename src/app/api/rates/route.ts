import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, ok, readJson, route } from '@/lib/server/api';
import { requireAdmin, requireUser } from '@/lib/server/auth';
import { dbDate, isoOf } from '@/lib/server/serialize';
import { currency, isoDate } from '@/lib/validation';

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
  const r = await prisma.exchangeRate.upsert({
    where: {
      fromCurrency_toCurrency_effectiveDate: {
        fromCurrency: data.fromCurrency,
        toCurrency: data.toCurrency,
        effectiveDate: dbDate(data.effectiveDate),
      },
    },
    update: { rate: data.rate },
    create: {
      fromCurrency: data.fromCurrency,
      toCurrency: data.toCurrency,
      rate: data.rate,
      effectiveDate: dbDate(data.effectiveDate),
    },
  });
  return ok({ id: r.id }, { status: 201 });
});
