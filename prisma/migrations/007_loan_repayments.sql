-- 007 — Devolución de préstamos entre unidades de negocio (control por abonos).
-- Idempotente y aditivo: dos columnas nuevas en "InterEntityTransfer". No modifica datos existentes.
--   "repaymentOfId": la transferencia es la DEVOLUCIÓN del préstamo indicado (una por préstamo).
--   "interestAmount": interés pactado incluido en la devolución (moneda de quien prestó; 0 = sin interés).

ALTER TABLE "InterEntityTransfer" ADD COLUMN IF NOT EXISTS "repaymentOfId" TEXT;
ALTER TABLE "InterEntityTransfer" ADD COLUMN IF NOT EXISTS "interestAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "InterEntityTransfer_repaymentOfId_key" ON "InterEntityTransfer"("repaymentOfId");

DO $$ BEGIN
  ALTER TABLE "InterEntityTransfer" ADD CONSTRAINT "InterEntityTransfer_repaymentOfId_fkey"
    FOREIGN KEY ("repaymentOfId") REFERENCES "InterEntityTransfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "InterEntityTransfer" ADD CONSTRAINT "InterEntityTransfer_interest_nonnegative" CHECK ("interestAmount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
