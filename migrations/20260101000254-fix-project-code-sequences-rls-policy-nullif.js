'use strict';

/**
 * Achado numa auditoria final de banco do Marco 6 (30/09/2026): a política RLS de
 * `construction.project_code_sequences` (criada em 20260101000239) é a ÚNICA das 20 tabelas
 * do módulo que faz `current_setting('app.company_id', true)::uuid` SEM o guard `NULLIF(...,
 * '')` que todas as outras 19 tabelas usam (mesmo padrão de `core.companies`,
 * `core.user_memberships` etc. desde o início do schema). Diferença de comportamento: se
 * `app.company_id` for setado como string vazia (nunca acontece no código real hoje — sempre
 * vem do payload do JWT — mas é o padrão defensivo estabelecido em todo o resto do projeto),
 * as outras 19 tabelas avaliam a política como NULL/false (nega acesso, graciosamente); esta
 * tabela lançaria um erro de cast do Postgres ("invalid input syntax for type uuid: \"\"") em
 * vez de negar com elegância. Alinha ao mesmo padrão defensivo do resto do projeto.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS tenant_isolation ON "construction"."project_code_sequences"`);
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."project_code_sequences"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS tenant_isolation ON "construction"."project_code_sequences"`);
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."project_code_sequences"
      USING (company_id = current_setting('app.company_id', true)::uuid)
      WITH CHECK (company_id = current_setting('app.company_id', true)::uuid)
    `);
  },
};
