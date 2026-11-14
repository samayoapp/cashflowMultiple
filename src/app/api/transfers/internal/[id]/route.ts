import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { voidInternalTransfer } from '@/lib/server/services';

export const dynamic = 'force-dynamic';

const schema = z.object({ action: z.literal('void') });

/** Anula una transferencia entre cuentas: revierte ambos saldos. */
export const POST = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const t = await prisma.accountTransfer.findUnique({ where: { id: params.id } });
  if (!t) throw notFound('Transferencia no encontrada');
  await assertEntityAccess(user, t.entityId);
  schema.parse(await readJson(req));
  const updated = await voidInternalTransfer(t.id);
  return ok({ status: updated.status });
});
