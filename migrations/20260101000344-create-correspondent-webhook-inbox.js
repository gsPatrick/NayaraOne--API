'use strict';

/**
 * Migration: Marco 8 Fase 6 — `correspondent.webhook_inbox`. Invariante do Caderno: "Inbox com
 * UNIQUE(provider,eventId) — webhook duplicado nunca aplica o status duas vezes." O financing_case
 * (e portanto o tenant) só é descoberto DEPOIS de localizar o external_case_id no payload — mesmo
 * padrão já usado em insurancePublicWebhook (procurement/insurance.controller.js): a linha só é
 * inserida depois de resolver a submissão/case e abrir a transação com `SET LOCAL app.*`, por
 * isso group_id/company_id são obrigatórios aqui (nunca inserimos sem saber o tenant).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    await queryInterface.createTable(
      { tableName: 'webhook_inbox', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        group_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        financing_case_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'financing_cases', schema: 'correspondent' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        provider_code: { type: Sequelize.STRING(32), allowNull: false },
        external_event_id: { type: Sequelize.STRING(160), allowNull: false },
        payload: { type: Sequelize.JSONB, allowNull: false },
        received_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // UNIQUE global por provider+eventId (não por empresa) — o evento é do provider externo, que
    // não sabe/não precisa saber do conceito de "empresa" do Nayara One; o mesmo externalEventId
    // nunca deveria se repetir pra tenants diferentes na prática, mas a garantia de dedup que o
    // Caderno pede é sobre o par (provider, eventId) em si.
    await sequelize.query(`
      CREATE UNIQUE INDEX webhook_inbox_provider_event_idx
        ON "correspondent"."webhook_inbox" (provider_code, external_event_id);
    `);

    await sequelize.query('ALTER TABLE "correspondent"."webhook_inbox" ENABLE ROW LEVEL SECURITY;');
    await sequelize.query('ALTER TABLE "correspondent"."webhook_inbox" FORCE ROW LEVEL SECURITY;');
    await sequelize.query(`
      CREATE POLICY tenant_isolation ON "correspondent"."webhook_inbox"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    const [[{ exists: runtimeExists }]] = await sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await sequelize.query('GRANT SELECT, INSERT ON "correspondent"."webhook_inbox" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "correspondent"."webhook_inbox";');
    await sequelize.query('ALTER TABLE "correspondent"."webhook_inbox" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'webhook_inbox', schema: 'correspondent' });
  },
};
