-- 001_init.sql — Esquema base de Cashflow Publimatec.
-- IDEMPOTENTE: puede ejecutarse cualquier número de veces sin perder datos.
-- Generado desde prisma/schema.prisma y adaptado con IF NOT EXISTS / DO-blocks.
-- Nunca agregar DROP ni DELETE en estos archivos.

DO $$ BEGIN
  CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AccountType" AS ENUM ('BANK', 'CASH', 'WALLET');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "Direction" AS ENUM ('IN', 'OUT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ObligationStatus" AS ENUM ('OPEN', 'PARTIAL', 'SETTLED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "Priority" AS ENUM ('FIXED', 'FLEXIBLE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "Frequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MovementType" AS ENUM ('OPENING', 'PAYMENT', 'ADJUSTMENT', 'TRANSFER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "TransferKind" AS ENUM ('LOAN', 'CONTRIBUTION', 'TRANSFER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "TransferStatus" AS ENUM ('PLANNED', 'EXECUTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CounterpartyType" AS ENUM ('CUSTOMER', 'SUPPLIER', 'BOTH');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "StagingStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "UserEntityAccess" (
    "userId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,

    CONSTRAINT "UserEntityAccess_pkey" PRIMARY KEY ("userId","entityId")
);

CREATE TABLE IF NOT EXISTS "AppSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "reportingCurrency" TEXT NOT NULL DEFAULT 'HNL',
    "timezone" TEXT NOT NULL DEFAULT 'America/Tegucigalpa',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Entity" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'HNL',
    "color" TEXT NOT NULL DEFAULT '#10b981',
    "minCashThreshold" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "webhookTokenHash" TEXT,
    "webhookTokenHint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ExchangeRate" (
    "id" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Account" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL DEFAULT 'BANK',
    "institution" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CashMovement" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "MovementType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT,
    "transferId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Counterparty" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CounterpartyType" NOT NULL DEFAULT 'BOTH',
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Counterparty_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Category" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Obligation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "dueDate" DATE NOT NULL,
    "expectedDate" DATE NOT NULL,
    "status" "ObligationStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "Priority" NOT NULL DEFAULT 'FLEXIBLE',
    "isHypothetical" BOOLEAN NOT NULL DEFAULT false,
    "counterpartyId" TEXT,
    "categoryId" TEXT,
    "recurrenceId" TEXT,
    "occurrenceDate" DATE,
    "transferId" TEXT,
    "stagingItemId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Obligation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Payment" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "date" DATE NOT NULL,
    "cashMovementId" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RecurringRule" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "frequency" "Frequency" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "priority" "Priority" NOT NULL DEFAULT 'FLEXIBLE',
    "counterpartyId" TEXT,
    "categoryId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InterEntityTransfer" (
    "id" TEXT NOT NULL,
    "kind" "TransferKind" NOT NULL DEFAULT 'TRANSFER',
    "status" "TransferStatus" NOT NULL DEFAULT 'PLANNED',
    "fromEntityId" TEXT NOT NULL,
    "toEntityId" TEXT NOT NULL,
    "fromAccountId" TEXT,
    "toAccountId" TEXT,
    "amountFrom" DECIMAL(18,2) NOT NULL,
    "amountTo" DECIMAL(18,2) NOT NULL,
    "expectedDate" DATE NOT NULL,
    "executedDate" DATE,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterEntityTransfer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Scenario" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Scenario_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScenarioOverride" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "expectedDate" DATE,
    "amount" DECIMAL(18,2),
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScenarioOverride_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StagingItem" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "source" TEXT,
    "externalId" TEXT,
    "direction" "Direction",
    "description" TEXT,
    "amount" DECIMAL(18,2),
    "dueDate" DATE,
    "expectedDate" DATE,
    "counterparty" TEXT,
    "payload" JSONB NOT NULL,
    "status" "StagingStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StagingItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

CREATE UNIQUE INDEX IF NOT EXISTS "Entity_webhookTokenHash_key" ON "Entity"("webhookTokenHash");

CREATE UNIQUE INDEX IF NOT EXISTS "ExchangeRate_fromCurrency_toCurrency_effectiveDate_key" ON "ExchangeRate"("fromCurrency", "toCurrency", "effectiveDate");

CREATE INDEX IF NOT EXISTS "Account_entityId_idx" ON "Account"("entityId");

CREATE INDEX IF NOT EXISTS "CashMovement_entityId_date_idx" ON "CashMovement"("entityId", "date");

CREATE INDEX IF NOT EXISTS "CashMovement_accountId_idx" ON "CashMovement"("accountId");

CREATE INDEX IF NOT EXISTS "CashMovement_transferId_idx" ON "CashMovement"("transferId");

CREATE INDEX IF NOT EXISTS "Counterparty_entityId_idx" ON "Counterparty"("entityId");

CREATE INDEX IF NOT EXISTS "Category_entityId_idx" ON "Category"("entityId");

CREATE UNIQUE INDEX IF NOT EXISTS "Obligation_stagingItemId_key" ON "Obligation"("stagingItemId");

CREATE INDEX IF NOT EXISTS "Obligation_entityId_status_expectedDate_idx" ON "Obligation"("entityId", "status", "expectedDate");

CREATE INDEX IF NOT EXISTS "Obligation_transferId_idx" ON "Obligation"("transferId");

CREATE UNIQUE INDEX IF NOT EXISTS "Obligation_recurrenceId_occurrenceDate_key" ON "Obligation"("recurrenceId", "occurrenceDate");

CREATE UNIQUE INDEX IF NOT EXISTS "Payment_cashMovementId_key" ON "Payment"("cashMovementId");

CREATE INDEX IF NOT EXISTS "Payment_obligationId_idx" ON "Payment"("obligationId");

CREATE INDEX IF NOT EXISTS "RecurringRule_entityId_idx" ON "RecurringRule"("entityId");

CREATE INDEX IF NOT EXISTS "InterEntityTransfer_fromEntityId_idx" ON "InterEntityTransfer"("fromEntityId");

CREATE INDEX IF NOT EXISTS "InterEntityTransfer_toEntityId_idx" ON "InterEntityTransfer"("toEntityId");

CREATE UNIQUE INDEX IF NOT EXISTS "ScenarioOverride_scenarioId_obligationId_key" ON "ScenarioOverride"("scenarioId", "obligationId");

CREATE INDEX IF NOT EXISTS "StagingItem_entityId_status_idx" ON "StagingItem"("entityId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "StagingItem_entityId_source_externalId_key" ON "StagingItem"("entityId", "source", "externalId");

DO $$ BEGIN
  ALTER TABLE "UserEntityAccess" ADD CONSTRAINT "UserEntityAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "UserEntityAccess" ADD CONSTRAINT "UserEntityAccess_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Account" ADD CONSTRAINT "Account_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "InterEntityTransfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Counterparty" ADD CONSTRAINT "Counterparty_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Category" ADD CONSTRAINT "Category_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_recurrenceId_fkey" FOREIGN KEY ("recurrenceId") REFERENCES "RecurringRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "InterEntityTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Payment" ADD CONSTRAINT "Payment_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Payment" ADD CONSTRAINT "Payment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Payment" ADD CONSTRAINT "Payment_cashMovementId_fkey" FOREIGN KEY ("cashMovementId") REFERENCES "CashMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "InterEntityTransfer" ADD CONSTRAINT "InterEntityTransfer_fromEntityId_fkey" FOREIGN KEY ("fromEntityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "InterEntityTransfer" ADD CONSTRAINT "InterEntityTransfer_toEntityId_fkey" FOREIGN KEY ("toEntityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ScenarioOverride" ADD CONSTRAINT "ScenarioOverride_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ScenarioOverride" ADD CONSTRAINT "ScenarioOverride_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "StagingItem" ADD CONSTRAINT "StagingItem_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reglas de integridad adicionales (no expresables en Prisma)
DO $$ BEGIN
  ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_positive" CHECK ("amount" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_amount_positive" CHECK ("amount" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_amount_positive" CHECK ("amount" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "InterEntityTransfer" ADD CONSTRAINT "InterEntityTransfer_distinct_entities" CHECK ("fromEntityId" <> "toEntityId");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ExchangeRate" ADD CONSTRAINT "ExchangeRate_rate_positive" CHECK ("rate" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- Solo puede existir una entidad por defecto y un escenario por defecto
CREATE UNIQUE INDEX IF NOT EXISTS "Entity_single_default" ON "Entity"("isDefault") WHERE "isDefault" = true;
CREATE UNIQUE INDEX IF NOT EXISTS "Scenario_single_default" ON "Scenario"("isDefault") WHERE "isDefault" = true;
