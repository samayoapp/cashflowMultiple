-- 012 — Recurrencias HIPOTÉTICAS: solo se proyectan en modo simulación (what-if).
-- Idempotente y aditivo.

ALTER TABLE "RecurringRule" ADD COLUMN IF NOT EXISTS "isHypothetical" BOOLEAN NOT NULL DEFAULT false;
