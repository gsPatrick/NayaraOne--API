'use strict';

/**
 * Isola "people"."persons" por EMPRESA também entre empresas do MESMO grupo (achado ao vivo na homologação, 10/11/2026).
 *
 * Causa raiz: a migration 20260101000083 materializou o DDL literal da seção 26 do Caderno ("Política RLS concreta"):
 *   persons_company_select  FOR SELECT  USING (group_id = ctx AND company_scope_allows(company_id, ctx_company))
 *   persons_company_write   FOR ALL     USING (group_id = ctx) WITH CHECK (group_id = ctx)
 * No PostgreSQL, FOR ALL vale também para SELECT e políticas PERMISSIVAS se somam com OR. A leitura efetiva ficou
 * "(grupo E empresa) OU grupo" = "grupo": qualquer empresa do grupo lia, listava e alterava as pessoas das outras, e a
 * política de leitura por empresa do próprio Caderno ficava sem efeito (o plano mostra só o filtro por group_id).
 *
 * Correção (decisão registrada em Maturacao/demandas/decisoes-de-implementacao.md, entrada de 10/11/2026):
 * - persons_company_select fica como está (texto do Caderno).
 * - persons_company_write (FOR ALL) sai e dá lugar a uma política por comando de ESCRITA (INSERT, UPDATE, DELETE), que
 *   não alcançam o SELECT. Cada uma exige o grupo do contexto E o escopo da empresa, pela mesma company_scope_allows da
 *   leitura: sem isso, um UPDATE/DELETE sem WHERE ou um INSERT com company_id de outra empresa ainda passariam só pelo
 *   grupo. Caderno §26: "Quando a entidade pertencer a uma única empresa, preferir comparação direta de company_id";
 *   §7: "segregação obrigatória por group_id e company_id".
 * - Sem contexto de empresa (app.company_id vazio) company_scope_allows devolve false: nada é lido nem gravado.
 * - UNIQUE(group_id, tax_id_normalized) continua: o mesmo CPF/CNPJ em outra empresa do grupo é recusado com
 *   409 PERSON_DUPLICATE_TAX_ID (person.service.js), sem revelar a pessoa da outra empresa.
 *
 * As tabelas filhas (person_contacts, person_addresses, person_documents, person_roles, communication_consents,
 * files, file_links) já isolam por company_id e não mudam. Varredura de pg_policies (645 políticas): people.persons é a
 * única tabela com coluna company_id em que uma política que vale para SELECT não usa company_id, fora os cinco
 * lookups deliberados por token/usuário (guardados por test/rls.policiesSelectPorEmpresa.test.js).
 */
const CTX_GROUP = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const CTX_COMPANY = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const ESCOPO = `group_id = ${CTX_GROUP} AND company_scope_allows(company_id, ${CTX_COMPANY})`;

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE "people"."persons" ENABLE ROW LEVEL SECURITY;');
      await q('ALTER TABLE "people"."persons" FORCE ROW LEVEL SECURITY;');
      await q('DROP POLICY IF EXISTS persons_company_write ON "people"."persons";');
      await q('DROP POLICY IF EXISTS persons_company_insert ON "people"."persons";');
      await q('DROP POLICY IF EXISTS persons_company_update ON "people"."persons";');
      await q('DROP POLICY IF EXISTS persons_company_delete ON "people"."persons";');
      await q(`CREATE POLICY persons_company_insert ON "people"."persons" FOR INSERT WITH CHECK (${ESCOPO});`);
      await q(`CREATE POLICY persons_company_update ON "people"."persons" FOR UPDATE USING (${ESCOPO}) WITH CHECK (${ESCOPO});`);
      await q(`CREATE POLICY persons_company_delete ON "people"."persons" FOR DELETE USING (${ESCOPO});`);
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP POLICY IF EXISTS persons_company_insert ON "people"."persons";');
      await q('DROP POLICY IF EXISTS persons_company_update ON "people"."persons";');
      await q('DROP POLICY IF EXISTS persons_company_delete ON "people"."persons";');
      await q('DROP POLICY IF EXISTS persons_company_write ON "people"."persons";');
      // Volta exatamente ao estado da migration 20260101000083 (que tinha o vazamento entre empresas do mesmo grupo).
      await q(`CREATE POLICY persons_company_write ON "people"."persons" FOR ALL
        USING (group_id = ${CTX_GROUP})
        WITH CHECK (group_id = ${CTX_GROUP});`);
    });
  },
};
