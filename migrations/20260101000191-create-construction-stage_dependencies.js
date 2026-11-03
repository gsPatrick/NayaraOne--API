'use strict';

/**
 * Migration: cria "construction"."stage_dependencies" — dependências entre etapas de obra
 * (M6-03/M6-19/M6-56 do CHECKLIST_DE_ESCOPO Marco 6). Cada linha diz "stage_id depende de
 * depends_on_stage_id" (a etapa dependente só pode avançar depois que a etapa da qual depende
 * estiver concluída). A validação de ciclo é feita na camada de serviço (DFS no grafo de
 * dependências existentes antes de inserir uma nova aresta) — não dá para expressar "sem ciclo
 * transitivo" só com constraint de banco, por isso o `stageDependencies.service.js` faz a
 * checagem antes do INSERT.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'stage_dependencies', schema: 'construction' },
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
        stage_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'project_stages', schema: 'construction' }, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        depends_on_stage_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'project_stages', schema: 'construction' }, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query(`
      ALTER TABLE "construction"."stage_dependencies"
        ADD CONSTRAINT stage_dependencies_no_self_ref CHECK (stage_id <> depends_on_stage_id);
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE "construction"."stage_dependencies"
        ADD CONSTRAINT stage_dependencies_unique UNIQUE (stage_id, depends_on_stage_id);
    `);

    await queryInterface.sequelize.query('ALTER TABLE "construction"."stage_dependencies" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."stage_dependencies" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."stage_dependencies"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."stage_dependencies";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."stage_dependencies" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'stage_dependencies', schema: 'construction' });
  },
};
