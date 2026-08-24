'use strict';

/** Migration: cria "core"."user_memberships" — Vínculo de um usuário a uma empresa/unidade, com papel(is) associados. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'user_memberships', schema: 'core' },
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
        user_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        unit_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'units', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'ACTIVE',
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "core"."user_memberships" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "core"."user_memberships" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "core"."user_memberships"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    // Correção de segurança (achado ao provar RLS real sem superuser/BYPASSRLS): o login
    // (POST /v1/auth/login) precisa descobrir a QUAL company/group o usuário pertence ANTES de
    // qualquer contexto de tenant existir — é o próprio ovo-e-galinha da autenticação. Com
    // apenas a policy `tenant_isolation` (baseada em app.company_id), a consulta de login nunca
    // enxergava nenhuma linha (current_setting sem contexto = NULL) e login ficava sempre
    // bloqueado. Postgres combina múltiplas policies permissivas do mesmo tipo de comando com
    // OR, então esta segunda policy (só SELECT) autoriza explicitamente o usuário autenticado a
    // ler os PRÓPRIOS vínculos por user_id, independente de tenant — nunca os de outro usuário,
    // e nunca INSERT/UPDATE/DELETE (que continuam presos só à tenant_isolation).
    await queryInterface.sequelize.query(`
      CREATE POLICY self_membership_lookup ON "core"."user_memberships"
        FOR SELECT
        USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS self_membership_lookup ON "core"."user_memberships";');
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "core"."user_memberships";');
    await queryInterface.sequelize.query('ALTER TABLE "core"."user_memberships" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'user_memberships', schema: 'core' });
  },
};
