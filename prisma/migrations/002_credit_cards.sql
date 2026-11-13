-- 002 — Tarjetas de crédito como "cuenta puente" con ciclos de corte y cuotas.
-- Idempotente y aditivo: no borra ni modifica datos existentes.

ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'CREDIT_CARD';
ALTER TYPE "MovementType" ADD VALUE IF NOT EXISTS 'CARD_PAYMENT';

-- Configuración de la tarjeta (NULL en cuentas líquidas)
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "creditLimit" DECIMAL(18,2);
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "statementDay" INTEGER;
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "paymentDueDay" INTEGER;
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "defaultPaymentAccountId" TEXT;

DO $$ BEGIN
  ALTER TABLE "Account" ADD CONSTRAINT "Account_statementDay_check" CHECK ("statementDay" IS NULL OR ("statementDay" BETWEEN 1 AND 31));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Account" ADD CONSTRAINT "Account_paymentDueDay_check" CHECK ("paymentDueDay" IS NULL OR ("paymentDueDay" BETWEEN 1 AND 31));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Account" ADD CONSTRAINT "Account_defaultPaymentAccountId_fkey" FOREIGN KEY ("defaultPaymentAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Consumo hecho con tarjeta (conserva la categoría real del gasto)
CREATE TABLE IF NOT EXISTS "CardCharge" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "cardAccountId" TEXT NOT NULL,
    "purchaseDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "categoryId" TEXT,
    "counterpartyId" TEXT,
    "obligationId" TEXT,
    "movementId" TEXT NOT NULL,
    "isOpening" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardCharge_pkey" PRIMARY KEY ("id")
);

-- Cuota de un consumo asignada a un ciclo (corte + fecha límite de pago)
CREATE TABLE IF NOT EXISTS "CardInstallment" (
    "id" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "cardAccountId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "settledAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "statementDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,

    CONSTRAINT "CardInstallment_pkey" PRIMARY KEY ("id")
);

-- Pago (liquidación) de la tarjeta desde una cuenta líquida
CREATE TABLE IF NOT EXISTS "CardPayment" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "cardAccountId" TEXT NOT NULL,
    "fromAccountId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "date" DATE NOT NULL,
    "bankMovementId" TEXT NOT NULL,
    "cardMovementId" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CardPaymentAllocation" (
    "paymentId" TEXT NOT NULL,
    "installmentId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "CardPaymentAllocation_pkey" PRIMARY KEY ("paymentId", "installmentId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CardCharge_obligationId_key" ON "CardCharge"("obligationId");
CREATE UNIQUE INDEX IF NOT EXISTS "CardCharge_movementId_key" ON "CardCharge"("movementId");
CREATE INDEX IF NOT EXISTS "CardCharge_entityId_idx" ON "CardCharge"("entityId");
CREATE INDEX IF NOT EXISTS "CardCharge_cardAccountId_purchaseDate_idx" ON "CardCharge"("cardAccountId", "purchaseDate");
CREATE INDEX IF NOT EXISTS "CardInstallment_cardAccountId_dueDate_idx" ON "CardInstallment"("cardAccountId", "dueDate");
CREATE INDEX IF NOT EXISTS "CardInstallment_entityId_idx" ON "CardInstallment"("entityId");
CREATE INDEX IF NOT EXISTS "CardInstallment_chargeId_idx" ON "CardInstallment"("chargeId");
CREATE UNIQUE INDEX IF NOT EXISTS "CardPayment_bankMovementId_key" ON "CardPayment"("bankMovementId");
CREATE UNIQUE INDEX IF NOT EXISTS "CardPayment_cardMovementId_key" ON "CardPayment"("cardMovementId");
CREATE INDEX IF NOT EXISTS "CardPayment_cardAccountId_idx" ON "CardPayment"("cardAccountId");
CREATE INDEX IF NOT EXISTS "CardPaymentAllocation_installmentId_idx" ON "CardPaymentAllocation"("installmentId");

DO $$ BEGIN
  ALTER TABLE "CardCharge" ADD CONSTRAINT "CardCharge_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CardCharge" ADD CONSTRAINT "CardCharge_cardAccountId_fkey" FOREIGN KEY ("cardAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CardCharge" ADD CONSTRAINT "CardCharge_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CardCharge" ADD CONSTRAINT "CardCharge_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CardCharge" ADD CONSTRAINT "CardCharge_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CardCharge" ADD CONSTRAINT "CardCharge_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "CashMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CardInstallment" ADD CONSTRAINT "CardInstallment_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "CardCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CardInstallment" ADD CONSTRAINT "CardInstallment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CardInstallment" ADD CONSTRAINT "CardInstallment_cardAccountId_fkey" FOREIGN KEY ("cardAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_cardAccountId_fkey" FOREIGN KEY ("cardAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_bankMovementId_fkey" FOREIGN KEY ("bankMovementId") REFERENCES "CashMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_cardMovementId_fkey" FOREIGN KEY ("cardMovementId") REFERENCES "CashMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CardPaymentAllocation" ADD CONSTRAINT "CardPaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "CardPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CardPaymentAllocation" ADD CONSTRAINT "CardPaymentAllocation_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "CardInstallment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
