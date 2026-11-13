import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess, resolveContext } from '@/lib/server/scope';
import { direction, id, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** Clientes/proveedores y categorías del contexto. */
export const GET = route(async (req) => {
  const user = await requireUser();
  const ctx = await resolveContext(user, new URL(req.url).searchParams.get('ctx'));
  const [counterparties, categories] = await Promise.all([
    prisma.counterparty.findMany({
      where: { entityId: { in: ctx.entityIds } },
      orderBy: { name: 'asc' },
      select: { id: true, entityId: true, name: true, type: true },
    }),
    prisma.category.findMany({
      where: { entityId: { in: ctx.entityIds } },
      orderBy: { name: 'asc' },
      select: { id: true, entityId: true, name: true, direction: true, color: true },
    }),
  ]);
  return ok({ counterparties, categories });
});

const schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('counterparty'),
    entityId: id,
    name: shortText(160),
    type: z.enum(['CUSTOMER', 'SUPPLIER', 'BOTH']).default('BOTH'),
  }),
  z.object({ kind: z.literal('category'), entityId: id, name: shortText(80), direction }),
]);

export const POST = route(async (req) => {
  const user = await requireUser();
  const data = schema.parse(await readJson(req));
  await assertEntityAccess(user, data.entityId);
  if (data.kind === 'counterparty') {
    const c = await prisma.counterparty.create({
      data: { entityId: data.entityId, name: data.name, type: data.type },
    });
    return ok(c, { status: 201 });
  }
  const c = await prisma.category.create({
    data: { entityId: data.entityId, name: data.name, direction: data.direction },
  });
  return ok(c, { status: 201 });
});
