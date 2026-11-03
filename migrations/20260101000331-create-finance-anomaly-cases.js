'use strict';

/**
 * GAP REAL CORRIGIDO (varredura completa Marco 4 contra o Caderno Técnico, 11/10/2026):
 * "finance.anomaly_cases" é uma das 19 tabelas obrigatórias listadas na seção 5 ("Entidades/
 * tabelas obrigatórias") e aparece explicitamente na seção 17 ("Antifraude") — "Estorno
 * frequente → Anomaly case", "Valor fora do padrão → Anomaly score + revisão" — e na seção 19
 * ("Relatório semanal de saúde") — "Anomalias → Casos HIGH/CRITICAL abertos". Até esta correção,
 * o antifraude só marcava `requires_manual_review`/`manual_review_reason` direto no
 * FinancialEntry (um booleano solto, sem histórico, sem severidade própria, impossível de
 * listar/contar separadamente) — nunca existiu um registro de caso de anomalia com o seu
 * próprio ciclo de vida (aberto/resolvido), que é o que o relatório semanal precisa para
 * "openHighRiskAnomalies".
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'anomaly_cases', schema: 'finance' },
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
        case_type: { type: Sequelize.STRING(40), allowNull: false },
        risk_level: { type: Sequelize.STRING(16), allowNull: false },
        related_entity_type: { type: Sequelize.STRING(60), allowNull: true },
        related_entity_id: { type: Sequelize.UUID, allowNull: true },
        reason: { type: Sequelize.TEXT, allowNull: false },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'OPEN' },
        resolved_at: { type: Sequelize.DATE, allowNull: true },
        resolved_by: { type: Sequelize.UUID, allowNull: true },
        resolution_note: { type: Sequelize.TEXT, allowNull: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addIndex(
      { tableName: 'anomaly_cases', schema: 'finance' },
      ['company_id', 'status', 'risk_level'],
      { name: 'anomaly_cases_company_status_risk_idx' }
    );

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "finance"."anomaly_cases" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."anomaly_cases" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."anomaly_cases"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."anomaly_cases";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."anomaly_cases" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'anomaly_cases', schema: 'finance' });
  },
};
