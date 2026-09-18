'use strict';

/**
 * Migration: cria "finance"."intercompany_transfers" — transferência formal entre empresas do
 * mesmo grupo (M4-18).
 *
 * DECISÃO DE RLS (documentada conforme exigido): a tabela tem `company_id` própria e ela é
 * SEMPRE a empresa de ORIGEM (== from_company_id, garantido por CHECK constraint). Motivos:
 *   1. O padrão de isolamento do projeto inteiro é `company_id = current_setting('app.company_id')`
 *      com uma única coluna — usar uma policy com OR (from/to) criaria um segundo padrão de
 *      isolamento no banco, mais difícil de auditar e de provar correto.
 *   2. Quem cria e é dono do fato "saiu dinheiro daqui" é a empresa de origem; a empresa de
 *      destino enxerga o dinheiro entrando pelo lançamento (to_entry_id), que vive sob o RLS
 *      dela própria em finance.financial_entries.
 * CONSEQUÊNCIA HONESTA: operando no contexto da empresa de destino, a linha de transferência
 * NÃO é visível — só o lançamento de crédito correspondente. A conciliação
 * (reconcileIntercompanyTransfer) é, portanto, uma ação da empresa de origem.
 *
 * Os dois lançamentos (DEBIT na origem, CREDIT no destino) são criados na MESMA transação da
 * transferência — não existe transferência com apenas uma perna.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'intercompany_transfers', schema: 'finance' },
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
          comment: 'Empresa dona da linha para fins de RLS — sempre igual a from_company_id (origem)',
        },
        from_company_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        to_company_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
        reason: { type: Sequelize.TEXT, allowNull: true },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'PENDING',
          comment: 'PENDING|RECONCILED',
        },
        from_entry_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        to_entry_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        reconciled_at: { type: Sequelize.DATE, allowNull: true },
        reconciled_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query(`
      ALTER TABLE "finance"."intercompany_transfers"
        ADD CONSTRAINT intercompany_transfers_company_is_origin_ck CHECK (company_id = from_company_id);
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE "finance"."intercompany_transfers"
        ADD CONSTRAINT intercompany_transfers_distinct_companies_ck CHECK (from_company_id <> to_company_id);
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE "finance"."intercompany_transfers"
        ADD CONSTRAINT intercompany_transfers_amount_positive_ck CHECK (amount > 0);
    `);

    await queryInterface.sequelize.query('ALTER TABLE "finance"."intercompany_transfers" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."intercompany_transfers" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."intercompany_transfers"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."intercompany_transfers";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."intercompany_transfers" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'intercompany_transfers', schema: 'finance' });
  },
};
