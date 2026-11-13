import { z } from 'zod';
import { badRequest, ok, readJson, route } from '@/lib/server/api';
import { requireAdmin } from '@/lib/server/auth';
import { overrideToday } from '@/lib/server/fx';

export const dynamic = 'force-dynamic';

const rateStr = (min: number, max: number, label: string) =>
  z.union([z.string(), z.number()]).transform((v, ctx) => {
    const s = String(v).trim();
    if (!/^\d+(\.\d{1,4})?$/.test(s) || Number(s) < min || Number(s) > max) {
      ctx.addIssue({ code: 'custom', message: `${label} inválido (hasta 4 decimales)` });
      return z.NEVER;
    }
    return s;
  });

const schema = z.object({
  officialSellRate: rateStr(1, 1000, 'Tasa oficial').optional(),
  bankSpread: rateStr(0, 10, 'Spread').optional(),
  effectiveSellRate: rateStr(1, 1000, 'Tasa efectiva').optional(),
});

/** Ajuste manual de la tasa del día o del spread bancario global (solo ADMIN). */
export const POST = route(async (req) => {
  await requireAdmin();
  const data = schema.parse(await readJson(req));
  if (!data.officialSellRate && !data.bankSpread && !data.effectiveSellRate) throw badRequest('Indica la tasa o el spread');
  try {
    return ok(await overrideToday(data));
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : 'No se pudo guardar');
  }
});
