'use strict';

/**
 * Marco 9, M9-D214 — integration.dispatches ganha a política de confirmação da operação (ON_RESPONSE ou ON_STATUS, copiada do port
 * quando o envio nasce), o último status normalizado devolvido pelo fornecedor e o instante em que o fornecedor aceitou o envio
 * (SUBMITTED), e a marca de operação essencial (passa à frente quando a cota do fornecedor está escassa e atravessa o circuito aberto,
 * M9-D217 e M9-D218). São colunas de andamento: o gatilho de imutabilidade da D205 continua protegendo só o conteúdo aprovado.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."dispatches" ADD COLUMN IF NOT EXISTS confirmation_mode varchar(12);');
    await q('ALTER TABLE "integration"."dispatches" ADD COLUMN IF NOT EXISTS external_status varchar(64);');
    await q('ALTER TABLE "integration"."dispatches" ADD COLUMN IF NOT EXISTS submitted_at timestamptz;');
    await q('ALTER TABLE "integration"."dispatches" ADD COLUMN IF NOT EXISTS essential boolean NOT NULL DEFAULT false;');
    await q(`DO $c$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatches_confirmation_mode_chk') THEN
        ALTER TABLE "integration"."dispatches" ADD CONSTRAINT dispatches_confirmation_mode_chk CHECK (confirmation_mode IS NULL OR confirmation_mode IN ('ON_RESPONSE', 'ON_STATUS'));
      END IF;
    END $c$;`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."dispatches" DROP CONSTRAINT IF EXISTS dispatches_confirmation_mode_chk;');
    await q('ALTER TABLE "integration"."dispatches" DROP COLUMN IF EXISTS essential;');
    await q('ALTER TABLE "integration"."dispatches" DROP COLUMN IF EXISTS submitted_at;');
    await q('ALTER TABLE "integration"."dispatches" DROP COLUMN IF EXISTS external_status;');
    await q('ALTER TABLE "integration"."dispatches" DROP COLUMN IF EXISTS confirmation_mode;');
  },
};
