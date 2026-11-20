-- 011 — Frecuencia DIARIA para recurrencias (p. ej. ventas diarias proyectadas de una pulpería).
-- Idempotente y aditivo: solo agrega un valor al enum.

ALTER TYPE "Frequency" ADD VALUE IF NOT EXISTS 'DAILY' BEFORE 'WEEKLY';
