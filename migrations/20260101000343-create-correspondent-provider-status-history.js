'use strict';

/**
 * Migration: Marco 8 Fase 6 (Caderno "CORRESPONDENTE BANCÁRIO + NC + FINANCIAMENTOS") —
 * `correspondent.provider_status_history`. Invariante do Caderno: "Guardar rawProviderStatus e
 * normalizedStatus — nunca perder o status bruto original." / "Status fora de ordem não regride
 * o case (histórico append-only)." Por isso esta tabela nunca recebe UPDATE, só INSERT — toda
 * mudança de status (aplicada ou ignorada por estar fora de ordem) vira uma linha nova.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    await queryInterface.createTable(
      { tableName: 'provider_status_history', schema: 'correspondent' },
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
        raw_provider_status: { type: Sequelize.STRING(64), allowNull: false },
        normalized_status: { type: Sequelize.STRING(32), allowNull: true, comment: 'NULL quando o status bruto não bate com nenhum valor do mapa do provider — nunca descartamos o evento, só não sabemos normalizar.' },
        source: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'webhook', comment: 'webhook | manual' },
        applied: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false, comment: 'true quando a transição avançou financing_cases.status; false quando foi ignorada por estar fora de ordem (regressão) — a linha fica de qualquer forma, nunca se perde o evento bruto.' },
        occurred_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await sequelize.query(`
      CREATE INDEX provider_status_history_case_idx
        ON "correspondent"."provider_status_history" (financing_case_id, occurred_at DESC);
    `);

    await sequelize.query('ALTER TABLE "correspondent"."provider_status_history" ENABLE ROW LEVEL SECURITY;');
    await sequelize.query('ALTER TABLE "correspondent"."provider_status_history" FORCE ROW LEVEL SECURITY;');
    await sequelize.query(`
      CREATE POLICY tenant_isolation ON "correspondent"."provider_status_history"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    // ACHADO REAL já documentado desde a Fase 2 (PADRAO_COMPONENTES_E_REGRAS.md §2.4): o
    // `ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration` nunca se aplica de verdade — a
    // credencial real de DDL é "nayaraonebanco". GRANT explícito aqui, não confiar no default.
    const [[{ exists: runtimeExists }]] = await sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await sequelize.query('GRANT SELECT, INSERT ON "correspondent"."provider_status_history" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "correspondent"."provider_status_history";');
    await sequelize.query('ALTER TABLE "correspondent"."provider_status_history" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'provider_status_history', schema: 'correspondent' });
  },
};
