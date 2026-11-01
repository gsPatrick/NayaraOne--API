'use strict';

/**
 * M9-D900 (reabertura R4-L6) — governance.mig_runs ganha `heartbeat_at`: o sinal de vida do replay de lote. Um replay legítimo e longo renova o sinal a cada
 * `migracao.execucao.sinal_vida_s`; o registro só expira (`migracao.execucao.expira_replay_min`) quando o sinal para, ou seja, quando o processo caiu. Reversível.
 * RLS, FORCE e GRANTs da tabela já existem (migration 873); coluna nova não muda privilégio. Sem tabela nova.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query("DO $do$ BEGIN IF to_regclass('governance.mig_runs') IS NOT NULL THEN ALTER TABLE governance.mig_runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz; END IF; END $do$");
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query("DO $do$ BEGIN IF to_regclass('governance.mig_runs') IS NOT NULL THEN ALTER TABLE governance.mig_runs DROP COLUMN IF EXISTS heartbeat_at; END IF; END $do$");
  },
};
