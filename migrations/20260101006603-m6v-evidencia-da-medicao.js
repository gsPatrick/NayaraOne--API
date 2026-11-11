'use strict';

/**
 * Verificação independente do Marco 6 (M6-21). Guia do Marcelo §6: "approveMeasurement(): lockForUpdate → REVIEWED →
 * evidências → permissão → APPROVED → outbox measurement.approved"; Caderno §7: "não sobrescrever evidência/quantidade
 * silenciosamente".
 *  - construction.stage_measurements.evidence_file_ids: as evidências da medição (arquivos do módulo de arquivos da
 *    mesma empresa, examinados pelo antivírus). Mudam só por revisão nova (a medição não tem UPDATE de conteúdo).
 *  - CHECK: medição PAYABLE sempre aponta para a conta a pagar (nenhuma medição a pagar sem obrigação no Financeiro).
 * Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q("ALTER TABLE construction.stage_measurements ADD COLUMN IF NOT EXISTS evidence_file_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]");
    await q(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stage_measurements_payable_has_entry') THEN
        ALTER TABLE construction.stage_measurements ADD CONSTRAINT stage_measurements_payable_has_entry
          CHECK (status <> 'PAYABLE' OR payable_financial_entry_id IS NOT NULL);
      END IF;
    END $$`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE construction.stage_measurements DROP CONSTRAINT IF EXISTS stage_measurements_payable_has_entry');
    await q('ALTER TABLE construction.stage_measurements DROP COLUMN IF EXISTS evidence_file_ids');
  },
};
