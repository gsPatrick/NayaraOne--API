'use strict';

/**
 * Migration: Marco 8 — isolamento entre empresas na entrada de webhooks (achado da auditoria
 * independente de 25/10/2026).
 *
 * 1) `webhook_inbox`: a unique era GLOBAL por (provider, eventId). Como a tabela tem RLS, a
 *    checagem de duplicata do service só enxerga a empresa atual; se outra empresa já tinha o
 *    mesmo eventId, o INSERT batia na unique global e o evento legítimo era descartado como
 *    "duplicado". Agora a unique é por empresa + provider + eventId.
 * 2) `external_case_routing`: a chave primária era só o id externo do caso. Dois providers (ou
 *    duas empresas) com o mesmo id sobrescreviam o roteamento um do outro. Agora a chave é
 *    (provider, id externo).
 */
module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP INDEX IF EXISTS "correspondent"."webhook_inbox_provider_event_idx";');
    await sequelize.query(`
      CREATE UNIQUE INDEX webhook_inbox_company_provider_event_idx
        ON "correspondent"."webhook_inbox" (company_id, provider_code, external_event_id);
    `);
    await sequelize.query('ALTER TABLE "correspondent"."external_case_routing" DROP CONSTRAINT IF EXISTS external_case_routing_pkey;');
    await sequelize.query('ALTER TABLE "correspondent"."external_case_routing" ADD PRIMARY KEY (provider_code, external_case_id);');
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('ALTER TABLE "correspondent"."external_case_routing" DROP CONSTRAINT IF EXISTS external_case_routing_pkey;');
    await sequelize.query('ALTER TABLE "correspondent"."external_case_routing" ADD PRIMARY KEY (external_case_id);');
    await sequelize.query('DROP INDEX IF EXISTS "correspondent"."webhook_inbox_company_provider_event_idx";');
    await sequelize.query(`
      CREATE UNIQUE INDEX webhook_inbox_provider_event_idx
        ON "correspondent"."webhook_inbox" (provider_code, external_event_id);
    `);
  },
};
