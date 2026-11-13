import { prisma } from './db';
import { cents, isoOf, isoOrNull, dbDate } from './serialize';
import type { ResolvedContext } from './scope';
import { todayInTz } from '@/lib/dates';
import type {
  EngineAccountBalance,
  EngineEntity,
  EngineObligation,
  EngineOverride,
  EngineRate,
  EngineRule,
  ProjectionInput,
} from '@/lib/projection/types';

export async function getSettings() {
  return (
    (await prisma.appSetting.findUnique({ where: { id: 1 } })) ?? {
      id: 1,
      reportingCurrency: 'HNL',
      timezone: 'America/Tegucigalpa',
      updatedAt: new Date(),
    }
  );
}

export async function getDefaultScenarioId(): Promise<string> {
  const s = await prisma.scenario.findFirst({ where: { isDefault: true }, select: { id: true } });
  if (s) return s.id;
  const created = await prisma.scenario.create({ data: { name: 'Escenario principal', isDefault: true } });
  return created.id;
}

/** Saldo real por cuenta = suma de movimientos (incluye el de apertura). */
export async function getAccountBalances(entityIds: string[]): Promise<EngineAccountBalance[]> {
  const rows = await prisma.cashMovement.groupBy({
    by: ['accountId', 'entityId'],
    where: { entityId: { in: entityIds } },
    _sum: { amount: true },
  });
  return rows.map((r) => ({ accountId: r.accountId, entityId: r.entityId, balance: cents(r._sum.amount) }));
}

/** Arma el input completo del motor de proyección para el contexto. */
export async function loadProjectionInput(ctx: ResolvedContext, whatIf: boolean): Promise<ProjectionInput> {
  const settings = await getSettings();
  const today = todayInTz(settings.timezone);
  const entityIds = ctx.entityIds;

  const [entities, balances, obligations, rules, scenarioId, rates] = await Promise.all([
    prisma.entity.findMany({ where: { id: { in: entityIds } }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }),
    getAccountBalances(entityIds),
    prisma.obligation.findMany({
      where: {
        entityId: { in: entityIds },
        OR: [
          { status: { in: ['OPEN', 'PARTIAL'] } },
          // ocurrencias materializadas (aunque estén liquidadas) para no duplicar la virtual
          { recurrenceId: { not: null }, occurrenceDate: { gte: dbDate(today) } },
        ],
      },
      include: {
        payments: { select: { amount: true } },
        counterparty: { select: { name: true } },
        category: { select: { name: true } },
      },
    }),
    prisma.recurringRule.findMany({
      where: { entityId: { in: entityIds }, active: true },
      include: { counterparty: { select: { name: true } }, category: { select: { name: true } } },
    }),
    getDefaultScenarioId(),
    prisma.exchangeRate.findMany(),
  ]);

  const overrides = await prisma.scenarioOverride.findMany({
    where: { scenarioId, obligation: { entityId: { in: entityIds } } },
  });

  const engineEntities: EngineEntity[] = entities.map((e) => ({
    id: e.id,
    name: e.name,
    color: e.color,
    currency: e.currency,
    minCashThreshold: cents(e.minCashThreshold),
  }));

  const engineObligations: EngineObligation[] = obligations.map((o) => ({
    id: o.id,
    entityId: o.entityId,
    direction: o.direction,
    description: o.description,
    amount: cents(o.amount),
    paid: o.payments.reduce((s, p) => s + cents(p.amount), 0),
    dueDate: isoOf(o.dueDate),
    expectedDate: isoOf(o.expectedDate),
    status: o.status,
    priority: o.priority,
    isHypothetical: o.isHypothetical,
    transferId: o.transferId,
    recurrenceId: o.recurrenceId,
    occurrenceDate: isoOrNull(o.occurrenceDate),
    counterpartyName: o.counterparty?.name ?? null,
    categoryName: o.category?.name ?? null,
  }));

  const engineRules: EngineRule[] = rules.map((r) => ({
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
    counterpartyName: r.counterparty?.name ?? null,
    categoryName: r.category?.name ?? null,
  }));

  const engineOverrides: EngineOverride[] = overrides.map((o) => ({
    obligationId: o.obligationId,
    expectedDate: isoOrNull(o.expectedDate),
    amount: o.amount ? cents(o.amount) : null,
    excluded: o.excluded,
  }));

  const engineRates: EngineRate[] = rates.map((r) => ({
    fromCurrency: r.fromCurrency,
    toCurrency: r.toCurrency,
    rate: Number(r.rate.toString()),
    effectiveDate: isoOf(r.effectiveDate),
  }));

  const outputCurrency = ctx.consolidated
    ? settings.reportingCurrency
    : (engineEntities[0]?.currency ?? settings.reportingCurrency);

  return {
    today,
    entities: engineEntities,
    balances,
    obligations: engineObligations,
    rules: engineRules,
    overrides: engineOverrides,
    rates: engineRates,
    outputCurrency,
    consolidated: ctx.consolidated,
    whatIf,
  };
}
