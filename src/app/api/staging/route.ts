import { prisma } from '@/lib/server/db';
import { ok, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { getAllowedEntityIds } from '@/lib/server/scope';
import { cents, isoOrNull } from '@/lib/server/serialize';

export const dynamic = 'force-dynamic';

/** Bandeja de Conciliación Externa de todas las entidades accesibles. ?status=PENDING|APPROVED|REJECTED */
export const GET = route(async (req) => {
  const user = await requireUser();
  const status = new URL(req.url).searchParams.get('status') ?? 'PENDING';
  const entityIds = await getAllowedEntityIds(user);
  const rows = await prisma.stagingItem.findMany({
    where: {
      entityId: { in: entityIds },
      ...(status === 'PENDING' || status === 'APPROVED' || status === 'REJECTED' ? { status } : {}),
    },
    orderBy: { receivedAt: 'desc' },
    take: 200,
  });
  return ok(
    rows.map((s) => ({
      id: s.id,
      entityId: s.entityId,
      source: s.source,
      externalId: s.externalId,
      direction: s.direction,
      description: s.description,
      amount: s.amount ? cents(s.amount) : null,
      dueDate: isoOrNull(s.dueDate),
      expectedDate: isoOrNull(s.expectedDate),
      counterparty: s.counterparty,
      currency: s.currency,
      cardHint: s.cardHint,
      payload: s.payload,
      status: s.status,
      receivedAt: s.receivedAt.toISOString(),
    })),
  );
});
