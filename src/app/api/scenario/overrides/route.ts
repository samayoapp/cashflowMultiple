import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { conflict, notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess, getAllowedEntityIds } from '@/lib/server/scope';
import { getDefaultScenarioId } from '@/lib/server/projection-data';
import { dbDate, dec } from '@/lib/server/serialize';
import { id, isoDate, nonNegativeMoney } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const schema = z.object({
  obligationId: id,
  expectedDate: isoDate.nullable().optional(),
  amount: nonNegativeMoney.nullable().optional(),
  excluded: z.boolean().optional(),
});

/** Crea/actualiza un ajuste What-If sobre una partida real. Nunca modifica la partida. */
export const PUT = route(async (req) => {
  const user = await requireUser();
  const data = schema.parse(await readJson(req));
  const ob = await prisma.obligation.findUnique({ where: { id: data.obligationId } });
  if (!ob) throw notFound('Partida no encontrada');
  await assertEntityAccess(user, ob.entityId);
  // Las hipotéticas se editan directamente; aquí solo se permite encenderlas/apagarlas
  if (ob.isHypothetical && (data.amount !== undefined || data.expectedDate !== undefined)) {
    throw conflict('Las partidas hipotéticas se editan directamente');
  }
  const scenarioId = await getDefaultScenarioId();

  const fields = {
    expectedDate: data.expectedDate === undefined ? undefined : data.expectedDate ? dbDate(data.expectedDate) : null,
    amount: data.amount === undefined ? undefined : data.amount === null ? null : dec(data.amount),
    excluded: data.excluded,
  };
  const ov = await prisma.scenarioOverride.upsert({
    where: { scenarioId_obligationId: { scenarioId, obligationId: ob.id } },
    update: fields,
    create: { scenarioId, obligationId: ob.id, ...fields },
  });

  // Si quedó sin efecto, se elimina para mantener limpio el escenario
  if (!ov.excluded && ov.expectedDate === null && ov.amount === null) {
    await prisma.scenarioOverride.delete({ where: { id: ov.id } });
  }
  return ok({ ok: true });
});

/** ?obligationId=... quita un ajuste; sin parámetro reinicia el escenario (entidades accesibles). */
export const DELETE = route(async (req) => {
  const user = await requireUser();
  const obligationId = new URL(req.url).searchParams.get('obligationId');
  const scenarioId = await getDefaultScenarioId();
  if (obligationId) {
    const ob = await prisma.obligation.findUnique({ where: { id: obligationId } });
    if (!ob) throw notFound('Partida no encontrada');
    await assertEntityAccess(user, ob.entityId);
    await prisma.scenarioOverride.deleteMany({ where: { scenarioId, obligationId } });
    return ok({ ok: true });
  }
  const allowed = await getAllowedEntityIds(user, { includeArchived: true });
  const { count } = await prisma.scenarioOverride.deleteMany({
    where: { scenarioId, obligation: { entityId: { in: allowed } } },
  });
  return ok({ ok: true, removed: count });
});
