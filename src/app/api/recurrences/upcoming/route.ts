import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/server/db';
import { ok, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { resolveContext } from '@/lib/server/scope';
import { getSettings } from '@/lib/server/projection-data';
import { cents, dbDate, isoOf, isoOrNull } from '@/lib/server/serialize';
import { addDays, isISODate, todayInTz } from '@/lib/dates';
import { occurrenceKey, pendingOccurrences } from '@/lib/projection/recurrence';
import type { UpcomingOccurrenceDto } from '@/lib/server/dto';

export const dynamic = 'force-dynamic';

/**
 * Ocurrencias virtuales de recurrencias activas (aún no materializadas como CxC/CxP),
 * desde `from` (hoy por defecto; puede ser pasado, máx. 2 años atrás) hasta `days` días después de hoy.
 * Las pasadas salen con `past: true`: son fechas que nunca se registraron (cobro/pago sin anotar).
 * ?direction=IN|OUT  ?days=1..366 (90 por defecto)  ?from=YYYY-MM-DD  ?q=texto
 */
export const GET = route(async (req) => {
  const user = await requireUser();
  const sp = new URL(req.url).searchParams;
  const ctx = await resolveContext(user, sp.get('ctx'));
  const dir = sp.get('direction');
  const q = sp.get('q')?.trim();
  const days = Math.min(Math.max(Number(sp.get('days')) || 90, 1), 366);

  const settings = await getSettings();
  const today = todayInTz(settings.timezone);
  const to = addDays(today, days);
  const fromParam = sp.get('from');
  const minFrom = addDays(today, -731);
  const from = isISODate(fromParam) && fromParam < today ? (fromParam < minFrom ? minFrom : fromParam) : today;

  const where: Prisma.RecurringRuleWhereInput = {
    entityId: { in: ctx.entityIds },
    active: true,
    ...(dir === 'IN' || dir === 'OUT' ? { direction: dir } : {}),
    ...(q
      ? {
          OR: [
            { description: { contains: q, mode: 'insensitive' } },
            { counterparty: { name: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const rules = await prisma.recurringRule.findMany({
    where,
    include: { counterparty: { select: { id: true, name: true } }, category: { select: { id: true, name: true } } },
  });
  if (rules.length === 0) return ok([]);

  // Ocurrencias ya materializadas (en cualquier estado) reemplazan a la virtual
  const done = await prisma.obligation.findMany({
    where: {
      recurrenceId: { in: rules.map((r) => r.id) },
      occurrenceDate: { gte: dbDate(from), lte: dbDate(to) },
    },
    select: { recurrenceId: true, occurrenceDate: true },
  });
  const materialized = new Set(done.map((o) => occurrenceKey(o.recurrenceId!, isoOf(o.occurrenceDate!))));

  const engineRules = rules.map((r) => ({
    id: r.id,
    entityId: r.entityId,
    direction: r.direction,
    description: r.description,
    amount: cents(r.amount),
    frequency: r.frequency,
    startDate: isoOf(r.startDate),
    endDate: isoOrNull(r.endDate),
    priority: r.priority,
    active: r.active,
    isHypothetical: r.isHypothetical,
    counterparty: r.counterparty,
    category: r.category,
  }));

  return ok<UpcomingOccurrenceDto[]>(
    pendingOccurrences(engineRules, materialized, from, to)
      // Una hipotética nunca queda "sin registrar" en el pasado: solo proyecta hacia adelante
      .filter(({ rule, date }) => !(rule.isHypothetical && date < today))
      .map(({ rule, date }) => ({
      key: `${rule.id}:${date}`,
      ruleId: rule.id,
      entityId: rule.entityId,
      direction: rule.direction,
      description: rule.description,
      amount: rule.amount,
      date,
      frequency: rule.frequency,
      priority: rule.priority,
      counterparty: rule.counterparty,
      category: rule.category,
      past: date < today,
      isHypothetical: rule.isHypothetical,
    })),
  );
});

