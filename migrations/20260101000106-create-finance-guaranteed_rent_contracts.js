'use strict';

/**
 * Migration: cria "finance"."guaranteed_rent_contracts" — aluguel garantido (M07 Billing
 * Locação/Utilities): a imobiliária paga o proprietário mesmo se o locatário atrasar, e depois
 * tenta recuperar do locatário. Isso é um PRODUTO SEPARADO de rent_advances (antecipação) —
 * tabelas e fluxos distintos, nunca misturados (ver guaranteedRent.service.js e
 * rentAdvance.service.js).
 *
 * DECISÃO DE ENGENHARIA: cada pagamento (payable ao proprietário + receivable a recuperar do
 * locatário, ambos via FinancialEntry real) é registrado como uma entrada append-only em
 * `payments_json`, pelo mesmo motivo documentado em collection_cases (histórico auditável sem
 * uma tabela filha dedicada). Os FinancialEntry reais (fonte da verdade contábil) são
 * referenciados pelo id dentro de cada entrada do array.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'guaranteed_rent_contracts', schema: 'finance' },
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
        contract_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'contracts', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'ACTIVE',
          comment: 'ACTIVE|CANCELLED',
        },
        coverage_starts_at: { type: Sequelize.DATEONLY, allowNull: false },
        coverage_ends_at: { type: Sequelize.DATEONLY, allowNull: true },
        payments_json: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query(`
      ALTER TABLE "finance"."guaranteed_rent_contracts" ADD CONSTRAINT guaranteed_rent_contracts_contract_unique UNIQUE (contract_id);
    `);

    await queryInterface.sequelize.query('ALTER TABLE "finance"."guaranteed_rent_contracts" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."guaranteed_rent_contracts" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."guaranteed_rent_contracts"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."guaranteed_rent_contracts";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."guaranteed_rent_contracts" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'guaranteed_rent_contracts', schema: 'finance' });
  },
};
