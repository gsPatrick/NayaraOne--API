'use strict';

/**
 * Migration: Marco 8 Fase 6 — `correspondent.external_case_routing`.
 *
 * Mesmo padrão já estabelecido no projeto para resolver o tenant de um webhook público ANTES de
 * poder abrir uma transação com `SET LOCAL app.company_id` (problema "ovo e galinha": pra saber
 * o tenant é preciso consultar uma tabela, mas toda tabela de negócio tem FORCE ROW LEVEL
 * SECURITY, que bloqueia qualquer leitura sem o contexto já setado). Ver as mesmas "routing
 * tables" deliberadamente SEM RLS já existentes:
 *   migrations/20260101000172-create-legal-signature_provider_routing.js
 *   migrations/20260101000271-extend-payment-intents-for-bank-adapter.js (bank_payment_provider_routing)
 *   migrations/20260101000286-create-crm-carts.js (cart_share_routing)
 *   migrations/20260101000272-create-procurement-insurance-hub.js (insurance_provider_submissions
 *     — É a mesma ideia: ali a tabela de submissão em si é a routing table, sem RLS por design;
 *     aqui preferimos uma tabela DEDICADA só de roteamento, separada de `provider_submissions`
 *     (que tem RLS normal), pra não precisar abrir mão de RLS numa tabela com dado de negócio.)
 *
 * `correspondent.external_case_routing` é um mapeamento mínimo e não sensível (só IDs, nenhum
 * dado de negócio) entre `external_case_id` (gerado pelo provider) e o tenant/case
 * correspondente. Depois de resolver o tenant por aqui, toda consulta de negócio real
 * (ProviderSubmission, FinancingCase, histórico) acontece DENTRO da transação com RLS aplicado
 * normalmente — esta tabela nunca é usada como fonte de verdade de negócio, só de roteamento.
 *
 * Lembrete: `test/rls.catalog.allTables.test.js` tem uma lista explícita de exceções
 * (`DELIBERATE_NO_RLS_EXCEPTIONS`) — esta tabela precisa estar lá, senão o teste falha de
 * propósito (nenhuma tabela multiempresa fica sem RLS silenciosamente).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    await queryInterface.createTable(
      { tableName: 'external_case_routing', schema: 'correspondent' },
      {
        external_case_id: { type: Sequelize.STRING(160), primaryKey: true, allowNull: false },
        provider_code: { type: Sequelize.STRING(32), allowNull: false },
        financing_case_id: { type: Sequelize.UUID, allowNull: false },
        group_id: { type: Sequelize.UUID, allowNull: false },
        company_id: { type: Sequelize.UUID, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // Deliberadamente SEM RLS — ver comentário acima. Mesmo assim GRANT explícito, pelo mesmo
    // motivo documentado desde a Fase 2 (default privileges não se aplicam de verdade).
    const [[{ exists: runtimeExists }]] = await sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      // UPDATE também é necessário: o service grava esta tabela via `.upsert()` (Sequelize
      // traduz pra `INSERT ... ON CONFLICT (pk) DO UPDATE`), que exige privilégio de UPDATE
      // mesmo quando o caminho feliz é sempre um INSERT puro.
      await sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "correspondent"."external_case_routing" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: 'external_case_routing', schema: 'correspondent' });
  },
};
