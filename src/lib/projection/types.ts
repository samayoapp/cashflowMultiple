import type { ISODate } from '@/lib/dates';
import type { Cents } from '@/lib/money';

export type Direction = 'IN' | 'OUT';
export type Priority = 'FIXED' | 'FLEXIBLE';
export type Frequency = 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'YEARLY';
export type ObligationStatus = 'OPEN' | 'PARTIAL' | 'SETTLED' | 'CANCELLED';

export interface EngineEntity {
  id: string;
  name: string;
  color: string;
  currency: string;
  minCashThreshold: Cents; // en moneda de la entidad
}

/** Saldo real (apertura + movimientos) por cuenta, en moneda de la entidad. */
export interface EngineAccountBalance {
  accountId: string;
  entityId: string;
  balance: Cents;
  /** Sin valor = cuenta líquida. Las tarjetas no suman a la caja real (saldo negativo = deuda). */
  kind?: 'LIQUID' | 'CREDIT_CARD';
  /** Moneda del saldo si difiere de la de la entidad (sub-saldo en $ de una tarjeta bimoneda). */
  currency?: string | null;
  /** Tasa de venta USD→HNL de la tarjeta, en diezmilésimas (27.1672 -> 271672). */
  fxRate4?: number | null;
}

/** Cuota pendiente de un consumo con tarjeta, asignada a su fecha límite de pago. */
export interface EngineCardInstallment {
  id: string;
  chargeId: string;
  entityId: string;
  cardAccountId: string;
  cardName: string;
  description: string;
  categoryName?: string | null;
  counterpartyName?: string | null;
  purchaseDate: ISODate;
  number: number;
  count: number;
  amount: Cents; // en la moneda de la cuota
  settled: Cents;
  statementDate: ISODate;
  dueDate: ISODate;
  /** Moneda de la cuota; null/igual a la entidad = moneda local. */
  currency?: string | null;
  /** Tasa de venta USD→HNL de la tarjeta (diezmilésimas), para convertir la parte extranjera. */
  fxRate4?: number | null;
}

/** Desglose del pago de tarjeta: parte local + parte extranjera convertida a la tasa vigente. */
export interface CardBreakdown {
  base: Cents;
  foreign: Cents;
  foreignCurrency: string | null;
  rate4: number | null;
}

export interface CardStatementDetail {
  installmentId: string;
  chargeId: string;
  description: string;
  categoryName: string | null;
  counterpartyName: string | null;
  purchaseDate: ISODate;
  number: number;
  count: number;
  /** Moneda original de la cuota. */
  currency: string;
  /** Pendiente en la moneda original de la cuota. */
  pendingNative: Cents;
}

export interface EngineObligation {
  id: string;
  entityId: string;
  direction: Direction;
  description: string;
  amount: Cents; // monto total original
  paid: Cents; // suma de abonos
  dueDate: ISODate;
  expectedDate: ISODate;
  status: ObligationStatus;
  priority: Priority;
  isHypothetical: boolean;
  transferId: string | null;
  recurrenceId: string | null;
  occurrenceDate: ISODate | null;
  counterpartyName?: string | null;
  categoryName?: string | null;
}

export interface EngineRule {
  id: string;
  entityId: string;
  direction: Direction;
  description: string;
  amount: Cents;
  frequency: Frequency;
  startDate: ISODate;
  endDate: ISODate | null;
  priority: Priority;
  active: boolean;
  /** Solo se proyecta en modo simulación. */
  isHypothetical?: boolean;
  counterpartyName?: string | null;
  categoryName?: string | null;
}

/** Ajuste What-If sobre una partida real, sin modificarla. */
export interface EngineOverride {
  obligationId: string;
  expectedDate: ISODate | null;
  /** Monto PENDIENTE simulado (reemplaza el saldo pendiente real). */
  amount: Cents | null;
  excluded: boolean;
}

export interface EngineRate {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  effectiveDate: ISODate;
}

export interface ProjectionInput {
  today: ISODate;
  entities: EngineEntity[];
  balances: EngineAccountBalance[];
  obligations: EngineObligation[];
  rules: EngineRule[];
  overrides: EngineOverride[];
  rates: EngineRate[];
  /** Cuotas pendientes de tarjetas; se agrupan como "Pago Tarjeta" en su fecha límite. */
  cardInstallments?: EngineCardInstallment[];
  /** Moneda de salida. En vista consolidada: moneda de reporte; en una entidad: su moneda. */
  outputCurrency: string;
  /** true = vista "Todas las Entidades": netea transferencias inter-entidad. */
  consolidated: boolean;
  whatIf: boolean;
  weeks?: number; // por defecto 13
  days?: number; // por defecto 90
}

export interface ProjectedItem {
  key: string; // único: obligationId, `rule:<id>:<fecha>` o `card:<cuenta>:<fecha>`
  source: 'OBLIGATION' | 'RECURRENCE' | 'CARD_STATEMENT';
  obligationId: string | null;
  ruleId: string | null;
  entityId: string;
  direction: Direction;
  description: string;
  counterpartyName: string | null;
  categoryName: string | null;
  /** Monto pendiente en moneda de salida (siempre positivo). */
  amount: Cents;
  /** Monto pendiente en moneda de la entidad. */
  amountNative: Cents;
  nativeCurrency: string;
  /** Fecha usada para proyectar (Fecha Esperada, o hoy si está vencida). */
  date: ISODate;
  expectedDate: ISODate;
  dueDate: ISODate;
  overdue: boolean;
  priority: Priority;
  isHypothetical: boolean;
  /** true si un override What-If cambió fecha o monto. */
  simulated: boolean;
  transferId: string | null;
  status: ObligationStatus | 'PROJECTED';
  weekIndex: number | null; // null = fuera de las 13 semanas
  /** Solo CARD_STATEMENT: tarjeta y consumos/cuotas que forman el pago. */
  cardAccountId?: string;
  cardDetails?: CardStatementDetail[];
  cardBreakdown?: CardBreakdown;
}

export interface EntityFlow {
  inflows: Cents;
  outflows: Cents;
}

export interface WeekBucket {
  index: number;
  start: ISODate;
  end: ISODate;
  opening: Cents;
  inflows: Cents;
  outflows: Cents;
  net: Cents;
  closing: Cents;
  byEntity: Record<string, EntityFlow>;
}

export interface DailyPoint {
  date: ISODate;
  inflows: Cents;
  outflows: Cents;
  balance: Cents; // saldo al cierre del día
}

export interface EntityBreakdown {
  entityId: string;
  cash: Cents; // en moneda de salida (solo cuentas líquidas)
  cardDebt: Cents; // deuda flotante en tarjetas (positivo)
  inflows13w: Cents;
  outflows13w: Cents;
}

export interface ProjectionKpis {
  /** Solo cuentas líquidas (bancos, efectivo, billeteras). */
  cashToday: Cents;
  /** Deuda flotante en tarjetas de crédito (positivo, informativo). */
  cardDebt: Cents;
  net30: Cents;
  inflows30: Cents;
  outflows30: Cents;
  /** Días de operación cubiertos; null = sin salidas proyectadas (ilimitado). */
  runwayDays: number | null;
  lowPoint: { date: ISODate; balance: Cents };
  threshold: Cents;
  lowPointBelowZero: boolean;
  lowPointBelowThreshold: boolean;
}

export interface ProjectionResult {
  today: ISODate;
  currency: string;
  consolidated: boolean;
  whatIf: boolean;
  items: ProjectedItem[];
  weeks: WeekBucket[];
  daily: DailyPoint[];
  byEntity: EntityBreakdown[];
  kpis: ProjectionKpis;
  /** Pares de monedas sin tasa configurada (sus montos se omiten en el consolidado). */
  missingRates: string[];
}
