'use strict';

/**
 * RLS e FORCE RLS em "procurement"."insurance_provider_submissions", com a mesma política das demais tabelas do módulo.
 *
 * A migration 610 já parte do princípio de que a tabela mantém RLS: a rota pública do webhook da seguradora descobre a
 * empresa pela função SECURITY DEFINER procurement.resolve_insurance_submission_routing e só depois abre a sessão do
 * tenant. Mas um banco migrado do zero ficava SEM RLS nessa tabela (o homologado já tinha), e o teste de catálogo a
 * tratava como "exceção deliberada". Esta migration iguala os dois estados e é idempotente: onde a RLS e a política já
 * existem, não muda nada.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "procurement"."insurance_provider_submissions" ENABLE ROW LEVEL SECURITY');
    await q('ALTER TABLE "procurement"."insurance_provider_submissions" FORCE ROW LEVEL SECURITY');
    await q(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policy WHERE polrelid = 'procurement.insurance_provider_submissions'::regclass AND polname = 'tenant_isolation'
        ) THEN
          CREATE POLICY tenant_isolation ON "procurement"."insurance_provider_submissions"
            USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
        END IF;
      END $$;
    `);
  },

  // Não volta atrás de propósito: tirar a RLS de uma tabela multiempresa reabriria o vazamento entre empresas.
  down: async () => {},
};
