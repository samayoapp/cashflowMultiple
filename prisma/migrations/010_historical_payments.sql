-- 010 — Abonos HISTÓRICOS: registran que se pagó (bajan el saldo de la CxC/CxP) sin mover caja.
-- Idempotente y aditivo (no borra datos):
--   "Payment"."isHistorical": el abono es un registro histórico; no tiene cuenta ni movimiento de caja.
--   "accountId" y "cashMovementId" dejan de ser obligatorios (solo quedan vacíos en los históricos;
--   los abonos existentes no cambian). Relajar NOT NULL no elimina ningún dato.

ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "isHistorical" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Payment" ALTER COLUMN "accountId" DROP NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "cashMovementId" DROP NOT NULL;
