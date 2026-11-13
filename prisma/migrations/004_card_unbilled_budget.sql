-- 004 — Tarjetas: consumos iniciales no facturados (ciclo en curso) y presupuesto por ciclo.
-- Idempotente y aditivo: solo agrega columnas nullable. No modifica datos existentes.

-- Deuda inicial: NULL/'STATEMENT' = saldo del último estado de cuenta (se paga en la próxima fecha de pago);
-- 'UNBILLED' = consumos hechos después del último corte (se facturan en el próximo corte).
ALTER TABLE "CardCharge" ADD COLUMN IF NOT EXISTS "openingKind" TEXT;
DO $$ BEGIN
  ALTER TABLE "CardCharge" ADD CONSTRAINT "CardCharge_openingKind_check" CHECK ("openingKind" IS NULL OR "openingKind" IN ('STATEMENT', 'UNBILLED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Tope de gasto por ciclo de facturación, en la moneda de la entidad (consolidado si es bimoneda).
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "cycleBudget" DECIMAL(18,2);
