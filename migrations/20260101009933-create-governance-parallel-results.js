'use strict';

/**
 * M9-D903 — governance.parallel_results: resultado por execução, entidade, chave e campo. Guarda só o HASH do valor antigo e do novo (HMAC com o segredo de PII), nunca o claro.
 * `field` vazio = resultado do registro inteiro (MISSING_IN_NEW / MISSING_IN_OLD). O estado atual de cada diferença é o resultado da execução mais recente para a mesma
 * (janela, entidade, chave, campo): o índice abaixo serve essa consulta. RLS + FORCE. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.parallel_results (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        window_id uuid NOT NULL REFERENCES governance.parallel_windows(id) ON UPDATE CASCADE ON DELETE CASCADE,
        run_id uuid NOT NULL REFERENCES governance.parallel_runs(id) ON UPDATE CASCADE ON DELETE CASCADE,
        run_number integer NOT NULL,
        entity varchar(30) NOT NULL,
        source_key varchar(128) NOT NULL,
        field varchar(80) NOT NULL DEFAULT '',
        old_value_hash char(64) NULL,
        new_value_hash char(64) NULL,
        result varchar(12) NOT NULL,
        diff_kind varchar(16) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT parallel_results_result_chk CHECK (result IN ('MATCH', 'DIFF_ALLOWED', 'DIFF_BLOCKER')),
        CONSTRAINT parallel_results_kind_chk CHECK (diff_kind IS NULL OR diff_kind IN ('VALUE', 'MISSING_IN_NEW', 'MISSING_IN_OLD')),
        CONSTRAINT parallel_results_key_uq UNIQUE (run_id, entity, source_key, field)
      )`);
      await q('CREATE INDEX IF NOT EXISTS parallel_results_state_idx ON governance.parallel_results (window_id, entity, source_key, field, run_number DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.parallel_results'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.parallel_results');
  },
};
