'use strict';

/**
 * Migration: cria "core"."mfa_credentials" — segredo TOTP (RFC 6238) por usuário e códigos
 * de recuperação de uso único, suporte a MFA obrigatório para diretoria/financeiro/jurídico/
 * administradores e mudanças críticas (Caderno técnico Nayara).
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: "core"."users" é identidade global
 * sem RLS própria (um usuário pode ter memberships em múltiplas empresas), mas seguimos aqui
 * o mesmo padrão de "core"."sessions" (que também é por-usuário mas carrega group_id/company_id
 * do contexto em que a sessão foi criada) — mfa_credentials.company_id reflete o tenant em que
 * o usuário configurou o MFA (JWT do momento do setup), e a policy de RLS usa essa coluna. Uma
 * segunda empresa do mesmo usuário lerá/verificará essas credenciais dentro do MESMO
 * app.company_id — se o usuário alternar de empresa, precisa reconfigurar; isso é aceitável
 * porque hoje não há nenhum outro dado "global" de usuário armazenado sob RLS de tenant.
 *
 * secret_encrypted: segredo TOTP cifrado em repouso (AES-256-GCM, src/utils/mfaCrypto.js) —
 * nunca texto plano, nunca logado.
 * recovery_codes_hash: array de hashes (bcrypt) dos códigos de recuperação de uso único;
 * cada código usado é removido do array (consumo = remoção), nunca reutilizável.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'mfa_credentials', schema: 'core' },
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        user_id: {
          type: Sequelize.UUID,
          allowNull: false,
          unique: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
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
        secret_encrypted: {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        enabled: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        confirmed_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        recovery_codes_hash: {
          type: Sequelize.ARRAY(Sequelize.TEXT),
          allowNull: false,
          defaultValue: [],
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
    await queryInterface.sequelize.query('ALTER TABLE "core"."mfa_credentials" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "core"."mfa_credentials" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "core"."mfa_credentials"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "core"."mfa_credentials";');
    await queryInterface.sequelize.query('ALTER TABLE "core"."mfa_credentials" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'mfa_credentials', schema: 'core' });
  },
};
