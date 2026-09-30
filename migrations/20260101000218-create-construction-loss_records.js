'use strict';

/**
 * Migration: cria "construction"."loss_records" — perda/quebra de material de obra
 * (M6-14/M6-29/M6-60 do checklist de escopo do Marco 6).
 *
 * DECISÃO DE ENGENHARIA (acoplamento entre módulos paralelos): existe, em paralelo, um outro
 * agente implementando uma tabela simples de materiais diários (`daily_materials`, ver M6-09).
 * Para não acoplar este worktree ao dele (schema em construção simultânea, risco de migration
 * colidir ou de FK apontar pra tabela que ainda não existe), a lógica de "devolução gera
 * movimento inverso" (M6-28/M6-60) é implementada AQUI DENTRO, na própria `loss_records`, via
 * `movement_type` (LOSS|RETURN) + `related_loss_record_id` auto-referenciado — uma devolução é
 * um novo registro RETURN que aponta pro LOSS original, nunca um UPDATE que apaga o valor
 * perdido original (mesmo espírito append-only já usado no diário de obra e em Financeiro).
 * O saldo de material por obra é a soma de LOSS (negativo) + RETURN (positivo), calculada em
 * `lossRecords.service.js:getMaterialBalance`.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'loss_records', schema: 'construction' },
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
        material_description: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        quantity: {
          type: Sequelize.DECIMAL(18, 3),
          allowNull: false,
        },
        estimated_value: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: false,
        },
        reason: {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        movement_type: {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'LOSS',
          comment: 'LOSS|RETURN — RETURN gera movimento inverso de um LOSS (M6-28/M6-60).',
        },
        related_loss_record_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'loss_records', schema: 'construction' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        status: {
          type: Sequelize.STRING(24),
          allowNull: false,
          defaultValue: 'DRAFT',
          comment: 'DRAFT|PENDING_APPROVAL|APPROVED',
        },
        approved_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        approved_at: {
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

    await queryInterface.addIndex({ tableName: 'loss_records', schema: 'construction' }, ['project_id', 'material_description']);

    await queryInterface.sequelize.query('ALTER TABLE "construction"."loss_records" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."loss_records" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."loss_records"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."loss_records";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."loss_records" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'loss_records', schema: 'construction' });
  },
};
