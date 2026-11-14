'use strict';

/**
 * Migration: cria "finance"."collection_cases" — caso de cobrança aberto quando uma
 * competência (billing_schedule) fica em atraso (M07 Billing Locação/Utilities).
 *
 * Multa/juros/carência são calculados via Motor de Regras (REG-LOC-001/REG-LOC-002, ver
 * scripts/seedBillingRules.js) — as colunas penalty_amount/interest_amount/grace_days_applied
 * guardam o RESULTADO já calculado (auditável), e penalty_rule_version_id/grace_rule_version_id
 * guardam QUAL versão de regra decidiu, nunca um valor hardcoded.
 *
 * DECISÃO DE ENGENHARIA — versionamento de acordo de cobrança: o Caderno pede "acordo
 * VERSIONADO (nunca apaga a dívida original — histórico completo)" sem detalhar o desenho de
 * tabela. Em vez de uma tabela filha própria, usamos `agreements_json` (JSONB, array
 * append-only: nenhuma rotina do serviço remove ou sobrescreve entradas antigas, apenas
 * adiciona uma nova ao final) — a dívida original fica em `original_debt_amount` (nunca
 * alterado após a criação do caso) e cada acordo negociado vira uma nova entrada no array com
 * seu próprio timestamp/valor/parcelas. Optamos por essa forma por ser suficiente para o
 * requisito ("histórico completo", "nunca apaga") sem introduzir uma tabela adicional só para
 * guardar snapshots imutáveis — se no futuro for necessário indexar/filtrar acordos
 * individualmente por SQL, migrar para tabela própria é direto.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'collection_cases', schema: 'finance' },
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
          defaultValue: 'OPEN',
          comment: 'OPEN|AGREEMENT|RESOLVED|ESCALATED',
        },
        overdue_since: { type: Sequelize.DATEONLY, allowNull: false },
        original_debt_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
        current_balance: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
        penalty_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
        interest_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
        grace_days_applied: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        penalty_rule_version_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'rule_versions', schema: 'core' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        grace_rule_version_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'rule_versions', schema: 'core' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        agreements_json: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "finance"."collection_cases" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."collection_cases" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."collection_cases"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."collection_cases";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."collection_cases" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'collection_cases', schema: 'finance' });
  },
};
