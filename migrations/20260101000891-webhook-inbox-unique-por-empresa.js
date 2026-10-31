'use strict';

/**
 * Migration: M9-D211 (reabertura G1) — a deduplicação da caixa de entrada de webhooks passa a ser POR EMPRESA.
 * A unique era global (provider_code, external_event_id): o evento da empresa B respondia "duplicate" e era descartado se a empresa A já
 * tinha usado o mesmo id externo, e a resposta servia de oráculo de existência entre empresas. Agora a chave é
 * (company_id, provider_code, external_event_id), como o Correspondente já faz (migration 638). A tabela não muda de RLS (ENABLE + FORCE,
 * política tenant_isolation, da migration 658); nenhuma tabela nova.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."webhook_inbox" DROP CONSTRAINT IF EXISTS webhook_inbox_provider_event_unique;');
    await q(`ALTER TABLE "integration"."webhook_inbox"
      ADD CONSTRAINT webhook_inbox_company_provider_event_unique UNIQUE (company_id, provider_code, external_event_id);`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."webhook_inbox" DROP CONSTRAINT IF EXISTS webhook_inbox_company_provider_event_unique;');
    await q(`ALTER TABLE "integration"."webhook_inbox"
      ADD CONSTRAINT webhook_inbox_provider_event_unique UNIQUE (provider_code, external_event_id);`);
  },
};
