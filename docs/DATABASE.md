# Modelo de datos — Cashflow Publimatec

PostgreSQL 16. El esquema se define en `prisma/schema.prisma` y se aplica con SQL **idempotente** en
`prisma/migrations/*.sql` (ver `AGENTS.md`). Montos en `NUMERIC(18,2)`; fechas de tesorería en `DATE`.

## Principios de diseño

1. **Liquidez, no contabilidad.** No hay plan de cuentas, devengos ni asientos. Solo existen:
   el dinero que **hay** (movimientos reales de caja) y el dinero que **se espera** (partidas pendientes).
2. **El saldo real nunca se guarda: se deriva.** `saldo de una cuenta = Σ CashMovement.amount`.
   Así un abono, una transferencia o una conciliación no pueden desincronizar saldos.
3. **Aislamiento estricto por entidad.** Toda tabla operativa tiene `entityId`. Las contrapartes y categorías
   no se comparten entre entidades. La API valida el acceso en cada consulta (`src/lib/server/scope.ts`).
4. **La simulación no toca los registros reales.** Los escenarios What-If guardan *ajustes* aparte
   (`ScenarioOverride`) y las partidas hipotéticas se marcan con `isHypothetical`.
5. **Doble fecha.** `dueDate` es el vencimiento contractual (referencia); `expectedDate` es la fecha en la
   que realmente se espera mover el dinero, y es la **única** que usa la proyección.

## Diagrama

```
User ──< UserEntityAccess >── Entity ──< Account ──< CashMovement >── Payment >── Obligation
                                 │                        │                         │  │  │
                                 ├──< Counterparty ───────┼─────────────────────────┘  │  │
                                 ├──< Category ───────────┼────────────────────────────┘  │
                                 ├──< RecurringRule ──────┼──(ocurrencias materializadas)─┘
                                 ├──< StagingItem         │
                                 └──< InterEntityTransfer >┘ (origen y destino)
Scenario ──< ScenarioOverride >── Obligation
AppSetting (fila única)     ExchangeRate (tabla de tasas)
```

## Tablas

| Tabla | Para qué existe |
|---|---|
| **Entity** | Unidad de negocio. Moneda base, color identificador, umbral mínimo de caja, `isDefault` (Entidad Base creada en el primer arranque, única por índice parcial), `archivedAt` (se archiva, nunca se borra) y el **hash** SHA‑256 del token de webhook (el token completo solo se muestra una vez). |
| **User / UserEntityAccess** | `ADMIN` ve y administra todo. `USER` solo opera las entidades asignadas. Contraseñas con bcrypt (cost 12). |
| **AppSetting** | Fila única: moneda de reporte del consolidado (HNL) y zona horaria que define "hoy". |
| **ExchangeRate** | Tasa `from → to` por fecha de vigencia. Solo se usa para **presentar** el consolidado; los saldos se guardan siempre en la moneda nativa de la entidad. El motor usa la tasa vigente más reciente, su inversa o un cruce. |
| **Account** | Banco, caja chica o billetera de una entidad (misma moneda que la entidad). |
| **CashMovement** | Libro de caja real con monto con signo (`+` entra, `−` sale). Tipos: `OPENING` (saldo inicial), `PAYMENT` (abono), `ADJUSTMENT` (conciliación), `TRANSFER` (inter‑entidad, con `transferId`). |
| **Counterparty / Category** | Clientes, proveedores y categorías por entidad. |
| **Obligation** | Una CxC (`IN`) o CxP (`OUT`). Guarda el monto total; el pendiente es `amount − Σ Payment`. Estado `OPEN → PARTIAL → SETTLED` (o `CANCELLED`). Prioridad `FIXED` (inamovible) / `FLEXIBLE` (negociable). Puede ser hipotética, venir de una recurrencia (`recurrenceId` + `occurrenceDate`, únicos juntos), de una transferencia (`transferId`) o de la bandeja externa (`stagingItemId`). |
| **Payment** | Un abono. Une la partida con la cuenta y con **su** `CashMovement` (1:1). Se crean en una sola transacción con bloqueo de fila, por lo que nunca se puede abonar más que el pendiente. |
| **RecurringRule** | Plantilla semanal, quincenal, mensual o anual. El motor proyecta sus ocurrencias **virtualmente** desde hoy; cuando el usuario actúa sobre una (pagar, mover, editar) se **materializa** como `Obligation` y reemplaza a la virtual. |
| **InterEntityTransfer** | Préstamo, aporte o transferencia entre dos entidades propias (`amountFrom` / `amountTo` para monedas distintas). Al planificarse crea dos `Obligation` espejo; al ejecutarse crea dos `CashMovement` y las liquida. Todo comparte `transferId`, que es la marca que el consolidado usa para **netear**. |
| **Scenario / ScenarioOverride** | Escenario What‑If por defecto. Un override cambia la fecha esperada o el monto pendiente de una partida real, o la excluye, sin modificarla. |
| **StagingItem** | Bandeja de conciliación externa. Todo lo que llega por webhook queda `PENDING` con su payload original; al aprobarse se crea la `Obligation`. `(entityId, source, externalId)` es único para evitar duplicados. |

## Reglas de negocio y dónde se aplican

| Regla | Implementación |
|---|---|
| Proyectar por Fecha Esperada | `src/lib/projection/engine.ts` usa solo `expectedDate`. |
| Arrastre de vencidos | Pendiente con `expectedDate < hoy` → se ubica **hoy** con `overdue = true`. |
| Abonos parciales | `registerPayment` (`src/lib/server/services.ts`): movimiento + abono + estado en una transacción. |
| Neteo inter‑entidad | En vista consolidada el motor excluye todo lo que tiene `transferId`; los saldos reales ya están neteados porque cada lado mueve su propia cuenta. |
| Multi‑moneda | `CurrencyConverter` convierte a la moneda de reporte solo para presentar. |
| What‑If | Con la simulación apagada se ignoran overrides e hipotéticas; encendida se aplican. |
| Integridad | `CHECK` de montos positivos, entidades distintas en transferencias, tasa > 0; una sola entidad y un solo escenario por defecto (índices parciales). |
