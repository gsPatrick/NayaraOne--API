'use strict';

/**
 * Migration: Marco 8 Fase 3 (Caderno "CORRESPONDENTE BANCÁRIO + NC + FINANCIAMENTOS") —
 * `correspondent.simulations`. Invariante do Caderno: "Um financing_case por operação; múltiplas
 * simulações ficam versionadas" — cada chamada de simulação cria uma linha NOVA, nunca UPDATE
 * (ver simulations.service.js). `request_snapshot`/`response_snapshot` guardam exatamente o que
 * foi pedido e o que o ProviderAdapter (Fase 0) devolveu, pra comparação objetiva entre
 * simulações (Fase 10, NAY) sem depender de recalcular nada depois.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    await queryInterface.createTable(
      { tableName: 'simulations', schema: 'correspondent' },
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
        amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        term_months: { type: Sequelize.INTEGER, allowNull: false },
        monthly_payment: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        rate: { type: Sequelize.DECIMAL(9, 6), allowNull: false, comment: 'Taxa mensal (ex: 0.012 = 1,2% a.m.), sempre a que o provider devolveu — nunca recalculada no front.' },
        request_snapshot: { type: Sequelize.JSONB, allowNull: false },
        response_snapshot: { type: Sequelize.JSONB, allowNull: false },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await sequelize.query('ALTER TABLE "correspondent"."simulations" ENABLE ROW LEVEL SECURITY;');
    await sequelize.query('ALTER TABLE "correspondent"."simulations" FORCE ROW LEVEL SECURITY;');
    await sequelize.query(`
      CREATE POLICY tenant_isolation ON "correspondent"."simulations"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    // Consulta mais comum: todas as simulações de um case, mais recente primeiro.
    await sequelize.query(`
      CREATE INDEX simulations_financing_case_created_idx
        ON "correspondent"."simulations" (financing_case_id, created_at DESC);
    `);

    // ACHADO REAL já documentado na Fase 2 (PADRAO_COMPONENTES_E_REGRAS.md §2.4): o
    // `ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration` nunca se aplica de verdade — a
    // credencial real de DDL é "nayaraonebanco". GRANT explícito aqui, não confiar no default.
    const [[{ exists: runtimeExists }]] = await sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "correspondent"."simulations" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "correspondent"."simulations";');
    await sequelize.query('ALTER TABLE "correspondent"."simulations" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'simulations', schema: 'correspondent' });
  },
};
