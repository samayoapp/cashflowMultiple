import { prisma } from '@/lib/server/db';
import { ok, route } from '@/lib/server/api';
import { requireAdmin } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export const DELETE = route<{ params: { id: string } }>(async (_req, { params }) => {
  await requireAdmin();
  await prisma.exchangeRate.delete({ where: { id: params.id } });
  return ok({ ok: true });
});
