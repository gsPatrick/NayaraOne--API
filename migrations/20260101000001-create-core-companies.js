'use strict';

/** Migration: cria "core"."companies" — Empresa/pessoa jurídica operacional pertencente a um grupo. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'companies', schema: 'core' },
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
        name: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        legal_name: {
          type: Sequelize.STRING(255),
          allowNull: true,
        },
        tax_id: {
          type: Sequelize.STRING(32),
          allowNull: true,
          unique: true,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'ACTIVE',
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

    // Correção de segurança (achado no teste adversarial cross-company do Marco de RLS real):
    // "core"."companies" NÃO tinha RLS — dependia apenas de requirePermission na rota, o que
    // permitia a qualquer usuário autenticado com "companies:read" buscar/alterar QUALQUER
    // empresa de QUALQUER grupo por id, bastando adivinhar/enumerar o UUID. Como "companies"
    // não carrega company_id (ela É a company), a política usa group_id — o usuário só enxerga
    // empresas do seu próprio grupo (DB-002/DB-BLIND-002: RLS ENABLE + FORCE, deny-by-default).
    await queryInterface.sequelize.query('ALTER TABLE "core"."companies" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "core"."companies" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "core"."companies"
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "core"."companies";');
    await queryInterface.sequelize.query('ALTER TABLE "core"."companies" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'companies', schema: 'core' });
  },
};
