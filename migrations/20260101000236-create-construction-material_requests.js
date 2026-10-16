'use strict';

/**
 * Migration: cria "construction"."material_requests" — M6-28 (mínimo exigido para o Marco 6).
 *
 * DECISÃO DE ENGENHARIA (M6-28/M6-53): a especificação pede requisição de material com
 * recebimento/devolução integrados a Estoque e movimento inverso real. Essa integração completa
 * depende do módulo de Estoque/Patrimônio, que só é formalizado no Marco 7 (ver nota de escopo
 * cruzado na seção 6 do checklist do Marco 6). Aqui implementamos o MÍNIMO que nasce em Obras e
 * não depende de Estoque existir: registrar a requisição (o quê, quanto, de qual etapa) e marcar
 * quando foi efetivamente recebida. Quando o Marco 7 existir, o campo `status=RECEIVED` passa a
 * ser gatilho para o movimento de estoque real — por ora, é só o registro + evento de domínio.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'material_requests', schema: 'construction' },
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
        stage_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'project_stages', schema: 'construction' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        description: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        quantity: {
          type: Sequelize.DECIMAL(18, 3),
          allowNull: false,
        },
        unit: {
          type: Sequelize.STRING(16),
          allowNull: false,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'REQUESTED',
        },
        requested_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        received_at: {
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

    await queryInterface.sequelize.query('ALTER TABLE "construction"."material_requests" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."material_requests" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."material_requests"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."material_requests";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."material_requests" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'material_requests', schema: 'construction' });
  },
};
