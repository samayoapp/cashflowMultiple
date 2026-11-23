-- 014 — Abonos VINCULADOS a un consumo de tarjeta ya registrado: la partida queda pagada con ese
-- consumo (Payment.cashMovementId = movimiento del consumo) sin crear movimientos nuevos.
-- Al deshacerlo solo se desvincula: el consumo y su movimiento se conservan.
-- Idempotente y aditivo.

ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "linkedCharge" BOOLEAN NOT NULL DEFAULT false;
