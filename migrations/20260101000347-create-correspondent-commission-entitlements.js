'use strict';

/**
 * Migration: Marco 8 Fase 8 (Caderno "CORRESPONDENTE BANCÁRIO + NC + FINANCIAMENTOS") —
 * `correspondent.commission_entitlements`. Ciclo EXPECTED → CONFIRMED → RECEIVABLE → RECEIVED →
 * ADJUSTED (citação literal do Caderno). "RECEIVED" é observado via o status do
 * `financial_entries` vinculado (settleFinancialEntry, já existente no Financeiro) — não
 * duplicado aqui. "ADJUSTED" é um ajuste append-only (ver commissionEntitlements.service.js),
 * nunca sobrescreve/apaga o registro original.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    await queryInterface.createTable(
      { tableName: 'commission_entitlements', schema: 'correspondent' },
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
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'EXPECTED' },
        base_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        percentage: { type: Sequelize.DECIMAL(6, 3), allowNull: false },
        amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        rule_version_id: { type: Sequelize.UUID, allowNull: true },
        external_confirmation_id: { type: Sequelize.STRING(128), allowNull: true },
        financial_entry_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await sequelize.query('ALTER TABLE "correspondent"."commission_entitlements" ENABLE ROW LEVEL SECURITY;');
    await sequelize.query('ALTER TABLE "correspondent"."commission_entitlements" FORCE ROW LEVEL SECURITY;');
    await sequelize.query(`
      CREATE POLICY tenant_isolation ON "correspondent"."commission_entitlements"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    await sequelize.query(`
      CREATE INDEX commission_entitlements_financing_case_idx
        ON "correspondent"."commission_entitlements" (financing_case_id, created_at DESC);
    `);

    // Idempotência de confirmação ("Confirmação por external confirmation id idempotente — nunca
    // duplicar recebível", citação literal do Caderno): única por empresa, só quando informado.
    await sequelize.query(`
      CREATE UNIQUE INDEX commission_entitlements_external_confirmation_unique
        ON "correspondent"."commission_entitlements" (company_id, external_confirmation_id)
        WHERE external_confirmation_id IS NOT NULL;
    `);

    // ACHADO REAL já documentado na Fase 2/7 (PADRAO_COMPONENTES_E_REGRAS.md §2.4): GRANT
    // explícito, nunca confiar no default privileges da migration 336.
    const [[{ exists: runtimeExists }]] = await sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "correspondent"."commission_entitlements" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "correspondent"."commission_entitlements";');
    await sequelize.query('ALTER TABLE "correspondent"."commission_entitlements" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'commission_entitlements', schema: 'correspondent' });
  },
};
