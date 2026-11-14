-- 005 — Transferencias entre cuentas de una MISMA entidad (banco → caja chica, etc.).
-- Idempotente y aditivo: crea una tabla nueva y una columna nullable en "CashMovement".
-- No modifica datos existentes. (Las inter-entidad siguen en "InterEntityTransfer",
-- cuya restricción "InterEntityTransfer_distinct_entities" se mantiene intacta.)

CREATE TABLE IF NOT EXISTS "AccountTransfer" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fromAccountId" TEXT NOT NULL,
    "toAccountId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "date" DATE NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'EXECUTED',
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountTransfer_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "AccountTransfer" ADD CONSTRAINT "AccountTransfer_distinct_accounts" CHECK ("fromAccountId" <> "toAccountId");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AccountTransfer" ADD CONSTRAINT "AccountTransfer_amount_positive" CHECK ("amount" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AccountTransfer" ADD CONSTRAINT "AccountTransfer_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AccountTransfer" ADD CONSTRAINT "AccountTransfer_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AccountTransfer" ADD CONSTRAINT "AccountTransfer_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "AccountTransfer_entityId_date_idx" ON "AccountTransfer"("entityId", "date");

-- Movimientos de caja generados por una transferencia interna
ALTER TABLE "CashMovement" ADD COLUMN IF NOT EXISTS "accountTransferId" TEXT;

DO $$ BEGIN
  ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_accountTransferId_fkey" FOREIGN KEY ("accountTransferId") REFERENCES "AccountTransfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "CashMovement_accountTransferId_idx" ON "CashMovement"("accountTransferId");
