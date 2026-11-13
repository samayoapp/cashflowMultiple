import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, conflict, notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { obligationDto, obligationInclude } from '@/lib/server/dto';
import { cents, dbDate, dec } from '@/lib/server/serialize';
import { assertCategory, resolveCounterparty } from '@/lib/server/catalog';
import { id, isoDate, optionalText, positiveMoney, priority, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

async function load(idValue: string) {
  const o = await prisma.obligation.findUnique({ where: { id: idValue }, include: obligationInclude });
  if (!o) throw notFound('Partida no encontrada');
  return o;
}

export const GET = route<{ params: { id: string } }>(async (_req, { params }) => {
  const user = await requireUser();
  const o = await load(params.id);
  await assertEntityAccess(user, o.entityId);
  return ok(obligationDto(o));
});

const patchSchema = z.object({
  description: shortText(200).optional(),
  amount: positiveMoney.optional(),
  dueDate: isoDate.optional(),
  expectedDate: isoDate.optional(),
  priority: priority.optional(),
  counterpartyId: id.optional().nullable(),
  counterpartyName: z.string().trim().max(160).optional().nullable(),
  categoryId: id.optional().nullable(),
  notes: optionalText(1000),
  /** CANCELLED cancela; OPEN reabre una cancelada */
  status: z.enum(['CANCELLED', 'OPEN']).optional(),
});

/**
 * Edición de una partida real (cambia el registro). Para simular sin modificarla
 * se usan los overrides de /api/scenario/overrides.
 */
export const PATCH = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const o = await load(params.id);
  await assertEntityAccess(user, o.entityId);
  const data = patchSchema.parse(await readJson(req));
  const paid = o.payments.reduce((s, p) => s + cents(p.amount), 0);

  if (o.transferId) {
    // Transferencias: solo se reprograma la fecha (ambos lados a la vez)
    const allowed = Object.keys(data).every((k) => k === 'expectedDate' || k === 'notes');
    if (!allowed) throw conflict('En transferencias solo se puede reprogramar la fecha');
    if (data.expectedDate) {
      await prisma.$transaction([
        prisma.obligation.updateMany({
          where: { transferId: o.transferId },
          data: { expectedDate: dbDate(data.expectedDate) },
        }),
        prisma.interEntityTransfer.update({
          where: { id: o.transferId },
          data: { expectedDate: dbDate(data.expectedDate) },
        }),
      ]);
    }
    return ok(obligationDto(await load(o.id)));
  }

  if (data.amount !== undefined && data.amount < paid) {
    throw badRequest('El monto no puede ser menor que lo ya abonado');
  }
  if (data.status === 'CANCELLED' && o.status === 'SETTLED') throw conflict('La partida ya está liquidada');
  if (data.status === 'OPEN' && o.status !== 'CANCELLED') throw conflict('Solo se pueden reabrir partidas canceladas');

  const updated = await prisma.$transaction(async (tx) => {
    const counterpartyId =
      data.counterpartyId !== undefined || data.counterpartyName !== undefined
        ? await resolveCounterparty(tx, o.entityId, data, o.direction === 'IN' ? 'CUSTOMER' : 'SUPPLIER')
        : undefined;
    const categoryId = data.categoryId !== undefined ? await assertCategory(tx, o.entityId, data.categoryId) : undefined;

    const amount = data.amount ?? cents(o.amount);
    let status = o.status;
    if (data.status === 'CANCELLED') status = 'CANCELLED';
    else if (data.status === 'OPEN' || o.status !== 'CANCELLED') {
      status = paid === 0 ? 'OPEN' : paid >= amount ? 'SETTLED' : 'PARTIAL';
    }

    return tx.obligation.update({
      where: { id: o.id },
      data: {
        description: data.description,
        amount: data.amount !== undefined ? dec(data.amount) : undefined,
        dueDate: data.dueDate ? dbDate(data.dueDate) : undefined,
        expectedDate: data.expectedDate ? dbDate(data.expectedDate) : undefined,
        priority: data.priority,
        counterpartyId,
        categoryId,
        notes: data.notes === null ? undefined : data.notes,
        status,
      },
      include: obligationInclude,
    });
  });
  return ok(obligationDto(updated));
});

/** Solo las partidas hipotéticas (What-If) se eliminan; las reales se cancelan. */
export const DELETE = route<{ params: { id: string } }>(async (_req, { params }) => {
  const user = await requireUser();
  const o = await load(params.id);
  await assertEntityAccess(user, o.entityId);
  if (!o.isHypothetical) throw conflict('Las partidas reales no se eliminan: cancélalas');
  await prisma.obligation.delete({ where: { id: o.id } });
  return ok({ ok: true });
});
