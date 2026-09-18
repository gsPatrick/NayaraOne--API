'use strict';

/**
 * Migration (M3-20): cria "crm"."feedback_cases" — reclamações, elogios e conflitos com SLA e
 * escalonamento. Não existia NADA disso no sistema: reclamação de cliente chegava por
 * WhatsApp/e-mail e morria na caixa de entrada do corretor, sem prazo e sem escalonamento.
 *
 * DECISÃO DE ENGENHARIA (prazos de SLA não estavam explicitados no Caderno CURRENT):
 *   HIGH   = 24 horas
 *   MEDIUM = 72 horas
 *   LOW    = 7 dias
 * `sla_due_at` é calculado NA CRIAÇÃO (feedbackCases.service.js) e gravado — não calculado
 * na leitura — porque o prazo prometido ao cliente não pode mudar retroativamente se a
 * política de SLA for alterada depois. COMPLIMENT (elogio) também recebe SLA: o prazo vale
 * como "responder/agradecer", mantendo uma única máquina de estados para os três tipos.
 *
 * RLS completo (ENABLE + FORCE + policy tenant_isolation por company_id).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'feedback_cases', schema: 'crm' },
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
        person_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
          comment: 'Cliente/lead que registrou a reclamação, elogio ou conflito.',
        },
        opportunity_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'opportunities', schema: 'crm' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        type: {
          type: Sequelize.STRING(16),
          allowNull: false,
          comment: 'COMPLAINT|COMPLIMENT|CONFLICT',
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        severity: {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'MEDIUM',
          comment: 'LOW|MEDIUM|HIGH — define o SLA (7d/72h/24h).',
        },
        status: {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'OPEN',
          comment: 'OPEN|IN_PROGRESS|RESOLVED|ESCALATED',
        },
        assigned_to_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        sla_due_at: {
          type: Sequelize.DATE,
          allowNull: false,
          comment: 'Prazo do SLA, calculado na criação a partir da severity.',
        },
        escalated_at: { type: Sequelize.DATE, allowNull: true },
        resolved_at: { type: Sequelize.DATE, allowNull: true },
        resolution_notes: { type: Sequelize.TEXT, allowNull: true },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
      }
    );

    await queryInterface.addIndex({ tableName: 'feedback_cases', schema: 'crm' }, ['status', 'sla_due_at'], {
      name: 'crm_feedback_cases_status_sla_due_at_idx',
    });
    await queryInterface.addIndex({ tableName: 'feedback_cases', schema: 'crm' }, ['person_id'], {
      name: 'crm_feedback_cases_person_id_idx',
    });

    await queryInterface.sequelize.query('ALTER TABLE "crm"."feedback_cases" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "crm"."feedback_cases" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "crm"."feedback_cases"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "crm"."feedback_cases";');
    await queryInterface.sequelize.query('ALTER TABLE "crm"."feedback_cases" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'feedback_cases', schema: 'crm' });
  },
};
