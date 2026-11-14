import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { ok, readJson, route } from '@/lib/server/api';
import { requireAdmin, requireUser } from '@/lib/server/auth';
import { ENTITY_ORDER, getAllowedEntityIds } from '@/lib/server/scope';
import { entityDto } from '@/lib/server/dto';
import { dec } from '@/lib/server/serialize';
import { currency, hexColor, nonNegativeMoney, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const user = await requireUser();
  const ids = await getAllowedEntityIds(user, { includeArchived: true });
  const rows = await prisma.entity.findMany({
    where: { id: { in: ids } },
    orderBy: ENTITY_ORDER,
  });
  return ok(rows.map(entityDto));
});

const createSchema = z.object({
  name: shortText(120),
  currency: currency.default('HNL'),
  color: hexColor.default('#6366f1'),
  minCashThreshold: nonNegativeMoney.default(0),
});

export const POST = route(async (req) => {
  await requireAdmin();
  const data = createSchema.parse(await readJson(req));
  // Las nuevas entidades van al final del orden manual
  const last = await prisma.entity.aggregate({ _max: { sortOrder: true } });
  const e = await prisma.entity.create({
    data: {
      sortOrder: (last._max.sortOrder ?? 0) + 1,
      name: data.name,
      currency: data.currency,
      color: data.color,
      minCashThreshold: dec(data.minCashThreshold),
    },
  });
  return ok(entityDto(e), { status: 201 });
});
