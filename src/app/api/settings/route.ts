import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { ok, readJson, route } from '@/lib/server/api';
import { requireAdmin, requireUser } from '@/lib/server/auth';
import { getSettings } from '@/lib/server/projection-data';
import { currency } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  await requireUser();
  const s = await getSettings();
  return ok({ reportingCurrency: s.reportingCurrency, timezone: s.timezone });
});

const schema = z.object({
  reportingCurrency: currency.optional(),
  timezone: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Zona horaria inválida')
    .optional(),
});

export const PATCH = route(async (req) => {
  await requireAdmin();
  const data = schema.parse(await readJson(req));
  const s = await prisma.appSetting.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
  return ok({ reportingCurrency: s.reportingCurrency, timezone: s.timezone });
});
