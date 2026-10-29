'use strict';

/**
 * M9-D806 — governance.quality_scores: a nota (0 a 100) mais recente de cada cadastro. Uma linha por (empresa, entidade, cadastro); a avaliação trava a
 * linha FOR UPDATE, então duas avaliações do mesmo cadastro se serializam. RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.quality_scores (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        entity_type varchar(20) NOT NULL,
        entity_id uuid NOT NULL,
        score numeric(5,2) NOT NULL,
        passed_weight integer NOT NULL DEFAULT 0,
        applicable_weight integer NOT NULL DEFAULT 0,
        calculated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_qscores_entity_chk CHECK (entity_type IN ('PERSON', 'PROPERTY', 'SUPPLIER')),
        CONSTRAINT gov_qscores_score_chk CHECK (score >= 0 AND score <= 100)
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_qscores_entity_uq ON governance.quality_scores (company_id, entity_type, entity_id)');
      await q('CREATE INDEX IF NOT EXISTS gov_qscores_list_idx ON governance.quality_scores (company_id, entity_type, score)');
      await q("SELECT governance.apply_tenant_rls('governance.quality_scores'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.quality_scores');
  },
};
