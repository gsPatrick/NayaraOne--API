'use strict';

/**
 * Migration: cria "finance"."billing_schedule_items" — componentes separados de uma
 * competência de cobrança (aluguel, condomínio, IPTU, etc.), conforme M07 Billing
 * Locação/Utilities. Pagamento parcial da billing_schedule recompõe o saldo sem fechar a
 * cobrança (ver billingSchedule.service.js) — os items em si não têm status próprio de
 * pagamento; o rateio de qual componente foi quitado primeiro não está especificado no
 * Caderno, então o saldo é controlado no agregado (billing_schedules.balance), não item a
 * item — DECISÃO DE ENGENHARIA documentada aqui e em billingSchedule.service.js.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'billing_schedule_items', schema: 'finance' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
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
        billing_schedule_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'billing_schedules', schema: 'finance' }, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        component_type: {
          type: Sequelize.STRING(32),
          allowNull: false,
          comment: 'RENT|CONDO|IPTU|OTHER',
        },
        description: { type: Sequelize.STRING(255), allowNull: true },
        amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "finance"."billing_schedule_items" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."billing_schedule_items" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."billing_schedule_items"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."billing_schedule_items";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."billing_schedule_items" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'billing_schedule_items', schema: 'finance' });
  },
};
