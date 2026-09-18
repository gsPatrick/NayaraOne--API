'use strict';

/**
 * Migration: cria "finance"."payment_intents" — intenção de pagamento com snapshot e hash
 * dos dados aprovados (M4-07).
 *
 * Até aqui a proteção "se o dado mudar, a aprovação é invalidada" existia apenas como lock
 * otimista (`lock_version` comparado em approvals.service.js) — ver a ressalva explícita em
 * financeAntifraud.service.js: "finance.approval_requests NÃO tem uma coluna snapshot_hash".
 * Esta tabela fecha essa lacuna: guarda a CÓPIA COMPLETA (snapshot_json) dos dados do
 * lançamento no momento em que o pagamento foi proposto, mais o SHA-256 desse snapshot
 * (mesmo padrão de contentHash em legal/contractVersions.service.js). Na aprovação, o hash é
 * recalculado sobre o estado ATUAL do lançamento: divergiu, recusa.
 *
 * Append-only no espírito do ledger: o snapshot e o hash NUNCA são atualizados depois de
 * criados — só `status` evolui (PENDING -> APPROVED -> EXECUTED, ou -> CANCELLED).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'payment_intents', schema: 'finance' },
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        group_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        financial_entry_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        snapshot_json: {
          type: Sequelize.JSONB,
          allowNull: false,
          comment: 'Cópia completa dos dados aprovados do lançamento no momento da criação da intenção',
        },
        snapshot_hash: {
          type: Sequelize.STRING(64),
          allowNull: false,
          comment: 'SHA-256 do snapshot_json canônico',
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'PENDING',
          comment: 'PENDING|APPROVED|EXECUTED|CANCELLED',
        },
        approval_request_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'approval_requests', schema: 'finance' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        approved_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        approved_at: { type: Sequelize.DATE, allowNull: true },
        executed_at: { type: Sequelize.DATE, allowNull: true },
        cancelled_at: { type: Sequelize.DATE, allowNull: true },
        cancel_reason: { type: Sequelize.TEXT, allowNull: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addIndex(
      { tableName: 'payment_intents', schema: 'finance' },
      ['financial_entry_id'],
      { name: 'payment_intents_financial_entry_idx' }
    );

    await queryInterface.sequelize.query('ALTER TABLE "finance"."payment_intents" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."payment_intents" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."payment_intents"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."payment_intents";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."payment_intents" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'payment_intents', schema: 'finance' });
  },
};
