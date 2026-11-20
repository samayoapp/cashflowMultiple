import { prisma } from '@/lib/server/db';
import { ok, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { resolveContext } from '@/lib/server/scope';
import { transferDto, transferInclude } from '@/lib/server/dto';
import { buildInterUnitStatement } from '@/lib/projection/interunit';

export const dynamic = 'force-dynamic';

/** Estado de cuenta entre unidades (reembolsos, préstamos y devoluciones): ?ctx=… */
export const GET = route(async (req) => {
  const user = await requireUser();
  const ctx = await resolveContext(user, new URL(req.url).searchParams.get('ctx'));
  const rows = await prisma.interEntityTransfer.findMany({
    where: {
      OR: [{ fromEntityId: { in: ctx.entityIds } }, { toEntityId: { in: ctx.entityIds } }],
      AND: [{ OR: [{ kind: 'LOAN' }, { isReimbursement: true }, { repaymentOfId: { not: null } }] }],
    },
    include: transferInclude,
    orderBy: { expectedDate: 'desc' },
  });
  const transfers = rows.map((r) => {
    const t = transferDto(r);
    return {
      id: t.id,
      kind: t.kind,
      status: t.status,
      isReimbursement: t.isReimbursement,
      repaymentOfId: t.repaymentOfId,
      hasRepayment: Boolean(t.repayment && t.repayment.status !== 'CANCELLED'),
      fromEntityId: t.fromEntityId,
      toEntityId: t.toEntityId,
      amountFrom: t.amountFrom,
      amountTo: t.amountTo,
      paidFrom: t.paidFrom,
      paidTo: t.paidTo,
      expectedDate: t.expectedDate,
      executedDate: t.executedDate,
      expenseDate: t.expenseDate,
      description: t.description,
      interest: t.interest,
    };
  });
  return ok(buildInterUnitStatement(transfers, ctx.entityIds));
});
