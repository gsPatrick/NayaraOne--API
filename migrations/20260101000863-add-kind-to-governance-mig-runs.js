'use strict';

/**
 * M9-D900 (reabertura N3) — governance.mig_runs ganha `kind`: 'RUN' (execução pedida em POST /migration/runs) ou 'REPLAY' (registro de controle de um replay de lote). O replay
 * relê o legado como uma execução, então entra na mesma contagem de limites (por fonte, por empresa) sem aparecer na Torre como "última execução". Reversível. RLS e GRANTs
 * da tabela já existem (migration 873); coluna nova não muda privilégio. Sem tabela nova.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      // Banco novo: a migration 873 (que roda depois desta) já cria a tabela com `kind`; aqui só os bancos em que a 873 já tinha rodado precisam da coluna.
      await q(`DO $do$ BEGIN
        IF to_regclass('governance.mig_runs') IS NOT NULL THEN
          ALTER TABLE governance.mig_runs ADD COLUMN IF NOT EXISTS kind varchar(8) NOT NULL DEFAULT 'RUN';
          ALTER TABLE governance.mig_runs DROP CONSTRAINT IF EXISTS mig_runs_kind_chk;
          ALTER TABLE governance.mig_runs ADD CONSTRAINT mig_runs_kind_chk CHECK (kind IN ('RUN', 'REPLAY'));
        END IF;
      END $do$`);
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`DO $do$ BEGIN
        IF to_regclass('governance.mig_runs') IS NOT NULL THEN
          DELETE FROM governance.mig_runs WHERE kind = 'REPLAY';
          ALTER TABLE governance.mig_runs DROP CONSTRAINT IF EXISTS mig_runs_kind_chk;
          ALTER TABLE governance.mig_runs DROP COLUMN IF EXISTS kind;
        END IF;
      END $do$`);
    });
  },
};
