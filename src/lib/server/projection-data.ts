import { prisma } from './db';
import { cents, isoOf, isoOrNull, dbDate } from './serialize';
import type { ResolvedContext } from './scope';
import { todayInTz } from '@/lib/dates';
import { cardRateFor, getCurrentFx } from './fx';
import type {
  EngineAccountBalance,
  EngineCardInstallment,
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

/**
 * Saldo real por cuenta = suma de movimientos (incluye el de apertura).
 * Las tarjetas se marcan como CREDIT_CARD (saldo negativo = deuda) para que no sumen a la caja.
 */
export async function getAccountBalances(entityIds: string[]): Promise<EngineAccountBalance[]> {
  const [rows, cards, fx] = await Promise.all([
    prisma.cashMovement.groupBy({
      by: ['accountId', 'entityId', 'currency'],
      where: { entityId: { in: entityIds } },
      _sum: { amount: true },
    }),
    prisma.account.findMany({
      where: { entityId: { in: entityIds }, type: 'CREDIT_CARD' },
      select: { id: true, customSellRate: true },
    }),
    getCurrentFx(),
  ]);
  const cardRate = new Map(cards.map((c) => [c.id, cardRateFor(c, fx)]));
  return rows.map((r) => ({
    accountId: r.accountId,
    entityId: r.entityId,
    balance: cents(r._sum.amount),
    kind: cardRate.has(r.accountId) ? ('CREDIT_CARD' as const) : ('LIQUID' as const),
    currency: r.currency,
    fxRate4: r.currency ? (cardRate.get(r.accountId) ?? null) : null,
  }));
}

/** Cuotas de tarjeta con saldo pendiente (settledAmount < amount). */
export async function getPendingCardInstallments(entityIds: string[]): Promise<EngineCardInstallment[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "CardInstallment"
    WHERE "entityId" = ANY(${entityIds}) AND "settledAmount" < "amount"`;
  if (rows.length === 0) return [];
  const list = await prisma.cardInstallment.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    include: {
      card: { select: { name: true, customSellRate: true } },
      charge: {
        select: {
          description: true,
          purchaseDate: true,
          category: { select: { name: true } },
          counterparty: { select: { name: true } },
        },
      },
    },
  });
  const fx = await getCurrentFx();
  return list.map((i) => ({
    id: i.id,
    chargeId: i.chargeId,
    entityId: i.entityId,
    cardAccountId: i.cardAccountId,
    cardName: i.card.name,
    description: i.charge.description,
    categoryName: i.charge.category?.name ?? null,
    counterpartyName: i.charge.counterparty?.name ?? null,
    purchaseDate: isoOf(i.charge.purchaseDate),
    number: i.number,
    count: i.count,
    amount: cents(i.amount),
    settled: cents(i.settledAmount),
    statementDate: isoOf(i.statementDate),
    dueDate: isoOf(i.dueDate),
    currency: i.currency,
    fxRate4: i.currency ? cardRateFor(i.card, fx) : null,
  }));
}

/** Arma el input completo del motor de proyección para el contexto. */
export async function loadProjectionInput(ctx: ResolvedContext, whatIf: boolean): Promise<ProjectionInput> {
  const settings = await getSettings();
  const today = todayInTz(settings.timezone);
  const entityIds = ctx.entityIds;

  const [entities, balances, obligations, rules, scenarioId, rates, cardInstallments] = await Promise.all([
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
    getPendingCardInstallments(entityIds),
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
    cardInstallments,
    outputCurrency,
    consolidated: ctx.consolidated,
    whatIf,
  };
}
