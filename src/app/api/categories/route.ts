import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess, resolveContext } from '@/lib/server/scope';
import { createCategory } from '@/lib/server/catalog';
import { direction, id, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** Categorías del contexto con cuántas partidas, recurrencias y consumos de tarjeta las usan: ?ctx=… */
export const GET = route(async (req) => {
  const user = await requireUser();
  const ctx = await resolveContext(user, new URL(req.url).searchParams.get('ctx'));
  const rows = await prisma.category.findMany({
    where: { entityId: { in: ctx.entityIds } },
    orderBy: { name: 'asc' },
    include: { _count: { select: { obligations: true, rules: true, cardCharges: true } } },
  });
  return ok(
    rows.map((c) => ({
      id: c.id,
      entityId: c.entityId,
      name: c.name,
      direction: c.direction,
      color: c.color,
      uses: { obligations: c._count.obligations, rules: c._count.rules, cardCharges: c._count.cardCharges },
    })),
  );
});

const schema = z.object({
  entityId: id,
  name: shortText(80),
  direction,
  color: z.string().max(7).optional().nullable(),
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const data = schema.parse(await readJson(req));
  await assertEntityAccess(user, data.entityId);
  return ok(await createCategory(prisma, data), { status: 201 });
});
