'use strict';

/**
 * M9-D863 — governance.degradation_policies: a política de degradação por custo de um orçamento (um registro por orçamento). `steps` é a lista ORDENADA
 * de passos reversíveis e não críticos, cada um com o limiar (50, 75, 90 ou 100) a partir do qual pode ser aplicado. Nunca guarda função crítica nem recurso
 * de infraestrutura: a API só aceita os cinco passos do livro. RLS + FORCE pela empresa (função do alicerce, GRANT guardado).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.degradation_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        budget_id uuid NOT NULL REFERENCES governance.budgets(id) ON UPDATE CASCADE ON DELETE CASCADE,
        steps jsonb NOT NULL DEFAULT '[]'::jsonb,
        enabled boolean NOT NULL DEFAULT true,
        created_by uuid NULL,
        updated_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_degradation_policies_budget_uq UNIQUE (budget_id),
        CONSTRAINT gov_degradation_policies_steps_chk CHECK (jsonb_typeof(steps) = 'array')
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.degradation_policies'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.degradation_policies');
  },
};
