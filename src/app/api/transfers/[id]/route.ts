import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { badRequest, conflict, notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { createLoanRepaymentTx, deleteTransfer, payTransfer, undoTransferPayments, updateInterUnitTransfer } from '@/lib/server/services';
import { getSettings } from '@/lib/server/projection-data';
import { transferDto, transferInclude } from '@/lib/server/dto';
import { id, isoDate, nonNegativeMoney, optionalText, positiveMoney, shortText } from '@/lib/validation';
import { todayInTz } from '@/lib/dates';

export const dynamic = 'force-dynamic';

async function load(transferId: string) {
  const t = await prisma.interEntityTransfer.findUnique({ where: { id: transferId }, include: transferInclude });
  if (!t) throw notFound('Transferencia no encontrada');
  return t;
}

/** Detalle con lo abonado y el saldo pendiente de cada lado. */
export const GET = route<{ params: { id: string } }>(async (_req, { params }) => {
  const user = await requireUser();
  const t = await load(params.id);
  await assertEntityAccess(user, t.fromEntityId);
  await assertEntityAccess(user, t.toEntityId);
  return ok(transferDto(t));
});

/** Cuentas requeridas salvo en registros históricos (sin mover caja). */
const accounts = {
  fromAccountId: id.optional().nullable(),
  toAccountId: id.optional().nullable(),
  date: isoDate.optional(),
  historical: z.boolean().optional(),
};
const schema = z.discriminatedUnion('action', [
  /** Liquida todo lo pendiente. */
  z.object({ action: z.literal('execute'), ...accounts }),
  /** Abono parcial (devoluciones de préstamo). */
  z.object({ action: z.literal('pay'), ...accounts, amountFrom: positiveMoney, amountTo: positiveMoney.optional() }),
  /** Cancela lo pendiente (si es un préstamo sin entregar, también su devolución). */
  z.object({ action: z.literal('cancel') }),
  /** Deshace todos los abonos (y su caja) y la deja pendiente otra vez. */
  z.object({ action: z.literal('undo') }),
  /** Programa la devolución de un préstamo ya registrado. */
  z.object({ action: z.literal('repayment'), dueDate: isoDate, interest: nonNegativeMoney.default(0) }),
]);

export const POST = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const t = await load(params.id);
  await assertEntityAccess(user, t.fromEntityId);
  await assertEntityAccess(user, t.toEntityId);
  const data = schema.parse(await readJson(req));

  if (data.action === 'cancel') {
    if (t.status !== 'PLANNED') throw conflict('Solo se cancela lo que está pendiente');
    const repayment = t.repayment;
    await prisma.$transaction(async (tx) => {
      const ids = [t.id];
      // Un préstamo que no se entregó tampoco se devuelve
      if (repayment && repayment.status === 'PLANNED') ids.push(repayment.id);
      await tx.obligation.updateMany({ where: { transferId: { in: ids } }, data: { status: 'CANCELLED' } });
      await tx.interEntityTransfer.updateMany({ where: { id: { in: ids } }, data: { status: 'CANCELLED' } });
    });
    return ok({ status: 'CANCELLED' });
  }

  if (data.action === 'undo') {
    return ok(await undoTransferPayments(t.id));
  }

  if (data.action === 'repayment') {
    await prisma.$transaction((tx) => createLoanRepaymentTx(tx, t.id, { dueDate: data.dueDate, interest: data.interest, userId: user.id }));
    return ok(transferDto(await load(t.id)), { status: 201 });
  }

  const settings = await getSettings();
  const today = todayInTz(settings.timezone);
  if (data.historical && data.date && data.date > today) throw badRequest('Un registro histórico no puede tener fecha futura');
  await payTransfer({
    transferId: t.id,
    fromAccountId: data.fromAccountId,
    toAccountId: data.toAccountId,
    historical: data.historical,
    date: data.date ?? today,
    ...(data.action === 'pay' ? { amountFrom: data.amountFrom, amountTo: data.amountTo } : {}),
    userId: user.id,
  });
  return ok(transferDto(await load(t.id)));
});

const patchSchema = z.object({
  description: shortText(200).optional(),
  notes: optionalText(1000),
  /** Categoría del gasto en la unidad que reembolsa (solo reembolsos). */
  categoryId: id.optional().nullable(),
  amountFrom: positiveMoney.optional(),
  amountTo: positiveMoney.optional(),
  date: isoDate.optional(),
  /** Reembolsos: fecha en que se hizo el gasto. */
  expenseDate: isoDate.optional().nullable(),
});

/** Edita un reembolso o devolución entre unidades (ambas partidas a la vez). */
export const PATCH = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const t = await load(params.id);
  await assertEntityAccess(user, t.fromEntityId);
  await assertEntityAccess(user, t.toEntityId);
  const data = patchSchema.parse(await readJson(req));
  await updateInterUnitTransfer({ transferId: t.id, ...data });
  return ok(transferDto(await load(t.id)));
});

/** Elimina una transferencia entre unidades registrada por error; si ya movió caja, la revierte. */
export const DELETE = route<{ params: { id: string } }>(async (_req, { params }) => {
  const user = await requireUser();
  const t = await load(params.id);
  await assertEntityAccess(user, t.fromEntityId);
  await assertEntityAccess(user, t.toEntityId);
  return ok(await deleteTransfer(t.id));
});
