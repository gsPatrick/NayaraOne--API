'use strict';

/**
 * Marco 8 — lacunas da revisão de 24/10/2026:
 *  - revisão de possível duplicata (alerta/reusa do caderno): estado, quem revisou, quando e a nota;
 *  - erros de integração com estado (aberto/resolvido) para a tela de acompanhamento;
 *  - DIMOB com origem por tipo (comissão ou locação), situação de validação e pendências por registro.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`ALTER TABLE "correspondent"."financing_cases"
      ADD COLUMN IF NOT EXISTS duplicate_review_status VARCHAR(16),
      ADD COLUMN IF NOT EXISTS duplicate_reviewed_by UUID,
      ADD COLUMN IF NOT EXISTS duplicate_reviewed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS duplicate_review_note TEXT`);
    await q(`UPDATE "correspondent"."financing_cases" SET duplicate_review_status = 'PENDING'
      WHERE possible_duplicate_of_case_id IS NOT NULL AND duplicate_review_status IS NULL`);
    await q(`ALTER TABLE "correspondent"."financing_cases"
      ADD CONSTRAINT financing_cases_duplicate_review_check CHECK (
        duplicate_review_status IS NULL OR duplicate_review_status IN ('PENDING','DISMISSED','CONFIRMED'))`);

    await q(`ALTER TABLE "correspondent"."integration_errors"
      ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'OPEN',
      ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS resolved_by UUID,
      ADD COLUMN IF NOT EXISTS resolution_note TEXT`);
    await q(`ALTER TABLE "correspondent"."integration_errors"
      ADD CONSTRAINT integration_errors_status_check CHECK (status IN ('OPEN','RESOLVED'))`);
    await q(`CREATE INDEX IF NOT EXISTS integration_errors_status_idx ON "correspondent"."integration_errors" (company_id, status, created_at DESC)`);

    await q(`ALTER TABLE "correspondent"."dimob_records"
      ADD COLUMN IF NOT EXISTS record_type VARCHAR(32) NOT NULL DEFAULT 'CORRESPONDENT_COMMISSION',
      ADD COLUMN IF NOT EXISTS validation_status VARCHAR(8) NOT NULL DEFAULT 'VALID',
      ADD COLUMN IF NOT EXISTS validation_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS detail_json JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await q(`ALTER TABLE "correspondent"."dimob_records"
      ADD CONSTRAINT dimob_records_type_check CHECK (record_type IN ('CORRESPONDENT_COMMISSION','LEASE')),
      ADD CONSTRAINT dimob_records_validation_check CHECK (validation_status IN ('VALID','INVALID'))`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "correspondent"."dimob_records" DROP CONSTRAINT IF EXISTS dimob_records_validation_check, DROP CONSTRAINT IF EXISTS dimob_records_type_check`);
    await q(`ALTER TABLE "correspondent"."dimob_records" DROP COLUMN IF EXISTS detail_json, DROP COLUMN IF EXISTS validation_issues, DROP COLUMN IF EXISTS validation_status, DROP COLUMN IF EXISTS record_type`);
    await q(`DROP INDEX IF EXISTS "correspondent"."integration_errors_status_idx"`);
    await q(`ALTER TABLE "correspondent"."integration_errors" DROP CONSTRAINT IF EXISTS integration_errors_status_check`);
    await q(`ALTER TABLE "correspondent"."integration_errors" DROP COLUMN IF EXISTS resolution_note, DROP COLUMN IF EXISTS resolved_by, DROP COLUMN IF EXISTS resolved_at, DROP COLUMN IF EXISTS status`);
    await q(`ALTER TABLE "correspondent"."financing_cases" DROP CONSTRAINT IF EXISTS financing_cases_duplicate_review_check`);
    await q(`ALTER TABLE "correspondent"."financing_cases" DROP COLUMN IF EXISTS duplicate_review_note, DROP COLUMN IF EXISTS duplicate_reviewed_at, DROP COLUMN IF EXISTS duplicate_reviewed_by, DROP COLUMN IF EXISTS duplicate_review_status`);
  },
};
