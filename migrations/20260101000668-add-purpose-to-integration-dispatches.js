'use strict';

/**
 * Marco 9, M9-D219 — integration.dispatches ganha a FINALIDADE do envio (trilha LGPD) e o contador de campos descartados pela
 * minimização. `purpose` (ex.: PAYMENT, LISTING_PUBLICATION, CUSTOMER_MESSAGE) é imutável junto com o conteúdo aprovado:
 * o gatilho de imutabilidade da D205 passa a protegê-lo também. `fields_dropped` é só um número (os nomes vão para o log).
 * Linhas anteriores ficam com purpose nulo (envios da D205 sem mapper).
 */
const FUNCTION_SQL = (purposeCheck) => `
  CREATE OR REPLACE FUNCTION "integration".dispatches_immutable() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN
    IF NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.operation IS DISTINCT FROM OLD.operation${purposeCheck}
       OR NEW.connection_id IS DISTINCT FROM OLD.connection_id THEN
      RAISE EXCEPTION 'INTEGRATION_DISPATCH_IMMUTABLE: o conteúdo aprovado de um envio não pode ser alterado' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.payload_snapshot IS DISTINCT FROM OLD.payload_snapshot THEN
      IF current_setting('integration.purge_mode', true) = 'on'
         AND NEW.payload_snapshot = jsonb_build_object('redacted', true, 'hash', OLD.payload_hash::text) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'INTEGRATION_DISPATCH_IMMUTABLE: o conteúdo aprovado de um envio não pode ser alterado' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END $f$;`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."dispatches" ADD COLUMN IF NOT EXISTS purpose varchar(48);');
    await q('ALTER TABLE "integration"."dispatches" ADD COLUMN IF NOT EXISTS fields_dropped integer;');
    await q(`DO $c$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatches_purpose_format_chk') THEN
        ALTER TABLE "integration"."dispatches" ADD CONSTRAINT dispatches_purpose_format_chk CHECK (purpose IS NULL OR purpose ~ '^[A-Z][A-Z0-9_]{2,47}$');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatches_fields_dropped_chk') THEN
        ALTER TABLE "integration"."dispatches" ADD CONSTRAINT dispatches_fields_dropped_chk CHECK (fields_dropped IS NULL OR fields_dropped >= 0);
      END IF;
    END $c$;`);
    await q(FUNCTION_SQL('\n       OR NEW.purpose IS DISTINCT FROM OLD.purpose'));
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(FUNCTION_SQL(''));
    await q('ALTER TABLE "integration"."dispatches" DROP CONSTRAINT IF EXISTS dispatches_fields_dropped_chk;');
    await q('ALTER TABLE "integration"."dispatches" DROP CONSTRAINT IF EXISTS dispatches_purpose_format_chk;');
    await q('ALTER TABLE "integration"."dispatches" DROP COLUMN IF EXISTS fields_dropped;');
    await q('ALTER TABLE "integration"."dispatches" DROP COLUMN IF EXISTS purpose;');
  },
};
