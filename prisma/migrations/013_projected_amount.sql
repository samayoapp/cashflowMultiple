-- 013 — Liquidación con monto real: al cerrar una partida con un monto distinto al proyectado,
-- "amount" pasa a ser el real y aquí se conserva el proyectado original (NULL = sin ajuste).
-- Idempotente y aditivo.

ALTER TABLE "Obligation" ADD COLUMN IF NOT EXISTS "projectedAmount" NUMERIC(18,2);
