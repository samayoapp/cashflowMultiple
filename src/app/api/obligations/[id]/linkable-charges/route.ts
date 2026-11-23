import { prisma } from '@/lib/server/db';
import { notFound, ok, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { linkableChargeWhere } from '@/lib/server/services';
import { cents, isoOf } from '@/lib/server/serialize';
import { rankLinkableCharges } from '@/lib/projection/settlement';

export const dynamic = 'force-dynamic';

/**
 * Consumos de tarjeta de la unidad que aún no corresponden a ninguna partida,
 * ordenados por parecido (monto y fecha) con la partida.
 */
export const GET = route<{ params: { id: string } }>(async (_req, { params }) => {
  const user = await requireUser();
  const o = await prisma.obligation.findUnique({ where: { id: params.id }, include: { payments: { select: { amount: true } } } });
  if (!o) throw notFound('Partida no encontrada');
  await assertEntityAccess(user, o.entityId);
  if (o.direction === 'IN') return ok([]);
  const charges = await prisma.cardCharge.findMany({
    where: linkableChargeWhere(o.entityId),
    include: { card: { select: { name: true } }, counterparty: { select: { name: true } } },
    orderBy: { purchaseDate: 'desc' },
    take: 300,
  });
  const remaining = cents(o.amount) - o.payments.reduce((s, p) => s + cents(p.amount), 0);
  const list = charges.map((c) => ({
    id: c.id,
    cardName: c.card.name,
    description: c.description,
    counterpartyName: c.counterparty?.name ?? null,
    purchaseDate: isoOf(c.purchaseDate),
    /** En la moneda de la unidad (lo que abona a la partida). */
    amount: cents(c.amountBase ?? c.amount),
    /** Moneda del consumo si fue en otra (p. ej. USD); null = la de la unidad. */
    currency: c.currency,
    originalAmount: cents(c.amount),
  }));
  return ok(rankLinkableCharges(list, remaining, isoOf(o.expectedDate)).slice(0, 50));
});
