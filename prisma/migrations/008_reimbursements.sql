-- 008 — Reembolsos entre unidades de negocio (gasto de una unidad pagado con la tarjeta de otra).
-- Idempotente y aditivo.
--   "InterEntityTransfer"."isReimbursement": la transferencia es un REEMBOLSO (se paga por abonos).
--   "CardCharge"."reimbursementTransferId": el consumo de tarjeta corresponde a ese reembolso
--   (el gasto se clasifica en la unidad que reembolsa, no en la dueña de la tarjeta).

ALTER TABLE "InterEntityTransfer" ADD COLUMN IF NOT EXISTS "isReimbursement" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CardCharge" ADD COLUMN IF NOT EXISTS "reimbursementTransferId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "CardCharge_reimbursementTransferId_key" ON "CardCharge"("reimbursementTransferId");

DO $$ BEGIN
  ALTER TABLE "CardCharge" ADD CONSTRAINT "CardCharge_reimbursementTransferId_fkey"
    FOREIGN KEY ("reimbursementTransferId") REFERENCES "InterEntityTransfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Marca los reembolsos creados antes de esta migración (siempre se crearon con el prefijo "Reembolso: ").
UPDATE "InterEntityTransfer"
   SET "isReimbursement" = true
 WHERE "isReimbursement" = false
   AND "kind" = 'TRANSFER'
   AND "repaymentOfId" IS NULL
   AND "description" LIKE 'Reembolso: %';
