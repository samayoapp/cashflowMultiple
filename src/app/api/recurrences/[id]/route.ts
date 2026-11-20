import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, notFound, ok, readJson, route } from '@/lib/server/api';
import { deleteRecurrence } from '@/lib/server/services';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { dbDate, dec, isoOf } from '@/lib/server/serialize';
import { frequency, id, isoDate, positiveMoney, priority, shortText } from '@/lib/validation';
import { ruleDto, ruleInclude } from '@/lib/server/dto';
import { assertCategory, resolveCounterparty } from '@/lib/server/catalog';

export const dynamic = 'force-dynamic';

const schema = z.object({
  description: shortText(200).optional(),
  amount: positiveMoney.optional(),
  frequency: frequency.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional().nullable(),
  priority: priority.optional(),
  active: z.boolean().optional(),
  /** Hipotética (solo simulación) ↔ real. También cambia sus fechas ya materializadas sin abonos. */
  isHypothetical: z.boolean().optional(),
  /** Nombre de cliente/proveedor; null o vacío la quita, undefined no la toca. */
  counterpartyName: z.string().trim().max(160).optional().nullable(),
  /** Categoría; también re-etiqueta las fechas ya registradas que tenían la anterior (no mueve dinero). */
  categoryId: id.optional().nullable(),
});

/** Los cambios aplican a ocurrencias futuras no materializadas. */
export const PATCH = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const r = await prisma.recurringRule.findUnique({ where: { id: params.id } });
  if (!r) throw notFound('Recurrencia no encontrada');
  await assertEntityAccess(user, r.entityId);
  const data = schema.parse(await readJson(req));
  const start = data.startDate ?? isoOf(r.startDate);
  const end = data.endDate === undefined ? (r.endDate ? isoOf(r.endDate) : null) : data.endDate;
  if (end && end < start) throw badRequest('La fecha final es anterior al inicio');

  const updated = await prisma.$transaction(async (tx) => {
    const counterpartyId =
      data.counterpartyName === undefined
        ? undefined
        : await resolveCounterparty(
            tx,
            r.entityId,
            { counterpartyName: data.counterpartyName || null },
            r.direction === 'IN' ? 'CUSTOMER' : 'SUPPLIER',
          );
    const categoryId = data.categoryId === undefined ? undefined : ((await assertCategory(tx, r.entityId, data.categoryId)) ?? null);
    if (categoryId !== undefined && categoryId !== r.categoryId) {
      // Etiqueta para análisis: las ocurrencias que seguían a la regla toman la nueva
      await tx.obligation.updateMany({ where: { recurrenceId: r.id, categoryId: r.categoryId }, data: { categoryId } });
    }
    if (data.isHypothetical !== undefined && data.isHypothetical !== r.isHypothetical) {
      // Las fechas ya materializadas y sin abonos siguen a la regla (las que tienen abonos son reales)
      await tx.obligation.updateMany({
        where: { recurrenceId: r.id, status: { in: ['OPEN', 'CANCELLED'] }, payments: { none: {} } },
        data: { isHypothetical: data.isHypothetical },
      });
    }
    return tx.recurringRule.update({
      where: { id: r.id },
      data: {
        description: data.description,
        amount: data.amount !== undefined ? dec(data.amount) : undefined,
        frequency: data.frequency,
        startDate: data.startDate ? dbDate(data.startDate) : undefined,
        endDate: data.endDate === undefined ? undefined : data.endDate ? dbDate(data.endDate) : null,
        priority: data.priority,
        active: data.active,
        isHypothetical: data.isHypothetical,
        counterpartyId,
        categoryId,
      },
      include: ruleInclude,
    });
  });
  return ok(ruleDto(updated));
});

/**
 * Elimina la recurrencia (p. ej. una duplicada por error). Sus ocurrencias sin abonos se borran;
 * las que ya tienen cobros/pagos se conservan como partidas puntuales (son historia real).
 */
export const DELETE = route<{ params: { id: string } }>(async (_req, { params }) => {
  const user = await requireUser();
  const r = await prisma.recurringRule.findUnique({ where: { id: params.id } });
  if (!r) throw notFound('Recurrencia no encontrada');
  await assertEntityAccess(user, r.entityId);
  return ok(await deleteRecurrence(r.id));
});
