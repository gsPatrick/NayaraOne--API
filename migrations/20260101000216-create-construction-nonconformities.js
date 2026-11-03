'use strict';

/**
 * Migration: cria "construction"."nonconformities" — Não Conformidade (NC) estruturada de
 * obra (M6-13/M6-24/M6-37/M6-38/M6-62/M6-78 do checklist de escopo do Marco 6).
 *
 * DECISÃO DE ENGENHARIA: a fonte (Anexo I) descreve a entidade conceitualmente ("severidade,
 * responsável, SLA, evidência antes/depois, aceite quando aplicável"), sem catálogo físico de
 * campo-a-campo (mesma lacuna documental já registrada para as outras tabelas conceituais do
 * módulo — ver M6-103 no checklist). Schema físico abaixo é definido por mim seguindo o mesmo
 * padrão das tabelas irmãs já existentes (quality_checklist_items, maintenance_cases):
 * `severity` é STRING(16) com enum de aplicação (LOW/MEDIUM/HIGH/CRITICAL) em vez de tipo
 * ENUM do Postgres (mesmo padrão usado em `status` de outras tabelas do módulo, que evita
 * migration de ALTER TYPE cara sempre que precisar adicionar um valor novo).
 * `before_evidence_file_ids`/`after_evidence_file_ids` são arrays de UUID (referenciam
 * "storage"."files", sem FK de array — mesma limitação de qualquer array de FK no Postgres,
 * validada em nível de aplicação no service).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'nonconformities', schema: 'construction' },
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
        project_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'projects', schema: 'construction' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        project_stage_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'project_stages', schema: 'construction' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        severity: {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'MEDIUM',
          comment: 'LOW|MEDIUM|HIGH|CRITICAL',
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        responsible_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        sla_due_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        status: {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'OPEN',
          comment: 'OPEN|CLOSED',
        },
        before_evidence_file_ids: {
          type: Sequelize.ARRAY(Sequelize.UUID),
          allowNull: false,
          defaultValue: [],
        },
        after_evidence_file_ids: {
          type: Sequelize.ARRAY(Sequelize.UUID),
          allowNull: false,
          defaultValue: [],
        },
        requires_acceptance: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        accepted_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        closed_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        lock_version: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addIndex({ tableName: 'nonconformities', schema: 'construction' }, ['project_id']);
    await queryInterface.addIndex({ tableName: 'nonconformities', schema: 'construction' }, ['status']);

    await queryInterface.sequelize.query('ALTER TABLE "construction"."nonconformities" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."nonconformities" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."nonconformities"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."nonconformities";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."nonconformities" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'nonconformities', schema: 'construction' });
  },
};
