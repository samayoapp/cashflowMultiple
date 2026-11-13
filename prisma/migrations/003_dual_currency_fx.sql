-- 003 — Tarjetas bimoneda (HNL/USD) y tipo de cambio diario con spread bancario.
-- Idempotente y aditivo: solo agrega columnas nullable o con default. No modifica datos existentes.

-- Tipo de cambio diario (amplía la tabla existente usada por la vista consolidada)
ALTER TABLE "ExchangeRate" ADD COLUMN IF NOT EXISTS "officialBuyRate" DECIMAL(10,4);
ALTER TABLE "ExchangeRate" ADD COLUMN IF NOT EXISTS "officialSellRate" DECIMAL(10,4);
ALTER TABLE "ExchangeRate" ADD COLUMN IF NOT EXISTS "bankSpread" DECIMAL(10,4);
ALTER TABLE "ExchangeRate" ADD COLUMN IF NOT EXISTS "effectiveSellRate" DECIMAL(10,4);
ALTER TABLE "ExchangeRate" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "ExchangeRate" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Configuración global del tipo de cambio
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "fxBankSpread" DECIMAL(10,4) NOT NULL DEFAULT 0.1800;
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "fxLastSyncAt" TIMESTAMP(3);
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "fxLastSyncError" TEXT;

-- Tarjetas bimoneda
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "foreignCurrency" TEXT;
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "creditLimitForeign" DECIMAL(18,2);
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "customSellRate" DECIMAL(10,4);

-- Moneda del movimiento (NULL = moneda de la entidad). Solo se usa en tarjetas.
ALTER TABLE "CashMovement" ADD COLUMN IF NOT EXISTS "currency" TEXT;
CREATE INDEX IF NOT EXISTS "CashMovement_accountId_currency_idx" ON "CashMovement"("accountId", "currency");

-- Consumos y cuotas en su moneda original
ALTER TABLE "CardCharge" ADD COLUMN IF NOT EXISTS "currency" TEXT;
ALTER TABLE "CardCharge" ADD COLUMN IF NOT EXISTS "exchangeRateAtTx" DECIMAL(10,4);
ALTER TABLE "CardCharge" ADD COLUMN IF NOT EXISTS "amountBase" DECIMAL(18,2);
ALTER TABLE "CardInstallment" ADD COLUMN IF NOT EXISTS "currency" TEXT;

-- Pagos por tramo de moneda (un pago bimoneda = dos filas con el mismo groupId)
ALTER TABLE "CardPayment" ADD COLUMN IF NOT EXISTS "currency" TEXT;
ALTER TABLE "CardPayment" ADD COLUMN IF NOT EXISTS "bankAmount" DECIMAL(18,2);
ALTER TABLE "CardPayment" ADD COLUMN IF NOT EXISTS "fxRateApplied" DECIMAL(10,4);
ALTER TABLE "CardPayment" ADD COLUMN IF NOT EXISTS "fxDifference" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "CardPayment" ADD COLUMN IF NOT EXISTS "groupId" TEXT;

-- Bandeja: moneda detectada y pista de tarjeta
ALTER TABLE "StagingItem" ADD COLUMN IF NOT EXISTS "currency" TEXT;
ALTER TABLE "StagingItem" ADD COLUMN IF NOT EXISTS "cardHint" TEXT;

DO $$ BEGIN
  ALTER TABLE "Account" ADD CONSTRAINT "Account_foreignCurrency_check" CHECK ("foreignCurrency" IS NULL OR "foreignCurrency" IN ('HNL', 'USD'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
