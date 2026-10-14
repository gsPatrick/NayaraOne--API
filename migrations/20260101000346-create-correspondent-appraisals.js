'use strict';

/**
 * Migration: Marco 8 Fase 7 (Caderno "CORRESPONDENTE BANCÁRIO + NC + FINANCIAMENTOS") —
 * `correspondent.appraisals`. Invariante crítico do Caderno, citação literal: "Avaliação do
 * provider nunca altera o preço do imóvel automaticamente (é só informativo/consultivo)." —
 * esta tabela só REGISTRA o resultado; nenhum código deste módulo escreve em
 * `properties.property_offers.asking_price` (confirmado por teste adversarial em
 * test/correspondent.appraisals.test.js).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    await queryInterface.createTable(
      { tableName: 'appraisals', schema: 'correspondent' },
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
        external_id: { type: Sequelize.STRING(128), allowNull: true },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'REQUESTED' },
        requested_value: { type: Sequelize.DECIMAL(14, 2), allowNull: true, comment: 'Valor avaliado quando concluído — nunca escrito de volta no imóvel/oferta.' },
        request_snapshot: { type: Sequelize.JSONB, allowNull: false },
        response_snapshot: { type: Sequelize.JSONB, allowNull: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await sequelize.query('ALTER TABLE "correspondent"."appraisals" ENABLE ROW LEVEL SECURITY;');
    await sequelize.query('ALTER TABLE "correspondent"."appraisals" FORCE ROW LEVEL SECURITY;');
    await sequelize.query(`
      CREATE POLICY tenant_isolation ON "correspondent"."appraisals"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    await sequelize.query(`
      CREATE INDEX appraisals_financing_case_created_idx
        ON "correspondent"."appraisals" (financing_case_id, created_at DESC);
    `);

    // ACHADO REAL já documentado na Fase 2 (PADRAO_COMPONENTES_E_REGRAS.md §2.4): o
    // `ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration` nunca se aplica de verdade — a
    // credencial real de DDL é "nayaraonebanco". GRANT explícito aqui, não confiar no default.
    const [[{ exists: runtimeExists }]] = await sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "correspondent"."appraisals" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "correspondent"."appraisals";');
    await sequelize.query('ALTER TABLE "correspondent"."appraisals" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'appraisals', schema: 'correspondent' });
  },
};
