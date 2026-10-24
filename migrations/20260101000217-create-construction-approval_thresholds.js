'use strict';

/**
 * Migration: cria "construction"."approval_thresholds" — limite de valor (alçada) configurável
 * por empresa acima do qual um registro de perda de material (loss_record, M6-14/M6-29/M6-60)
 * exige aprovação explícita antes de virar APPROVED.
 *
 * DECISÃO DE ENGENHARIA: o Anexo I pede alçada "via alçada, mesma lógica de aprovação
 * financeira do resto do sistema" (M6-29), mas não define o valor numérico do limite — isso é
 * necessariamente uma decisão operacional/de negócio, não uma regra fixa de código. Varri
 * `src/features/finance/` procurando um mecanismo de alçada genérico e reaproveitável (termos
 * "alçada"/"approval"/"threshold") e só encontrei uma constante pontual de antifraude
 * (`financeAntifraud.service.js: ANOMALY_NEW_ACCOUNT_THRESHOLD`, específica de detecção de
 * anomalia em conta nova, não um mecanismo de alçada genérico reaproveitável) — não um padrão de
 * alçada genérico pronto para reaproveitar aqui. Em vez de inventar uma constante hard-coded
 * (que violaria a regra geral do projeto contra "regra de negócio fixada em código", reforçada
 * no item M6-96/"Scanner de hard-code"), este valor vira uma linha configurável por empresa
 * nesta tabela, com um valor-padrão de seed de R$ 1.000,00 (mil reais) — number redondo típico
 * de alçada operacional de obra, ajustável por empresa sem deploy de código.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'approval_thresholds', schema: 'construction' },
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
        context: {
          type: Sequelize.STRING(64),
          allowNull: false,
          defaultValue: 'MATERIAL_LOSS',
          comment: 'Contexto de aplicação da alçada — hoje só MATERIAL_LOSS (M6-29), extensível a outros contextos.',
        },
        max_auto_approve_amount: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: false,
          defaultValue: 1000.0,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addConstraint({ tableName: 'approval_thresholds', schema: 'construction' }, {
      fields: ['company_id', 'context'],
      type: 'unique',
      name: 'approval_thresholds_company_context_unique',
    });

    await queryInterface.sequelize.query('ALTER TABLE "construction"."approval_thresholds" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."approval_thresholds" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."approval_thresholds"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."approval_thresholds";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."approval_thresholds" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'approval_thresholds', schema: 'construction' });
  },
};
