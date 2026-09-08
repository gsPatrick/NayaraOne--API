'use strict';

/**
 * Migration: cria "core"."mfa_step_ups" — janela de "MFA recente" configurável por risco
 * (Caderno técnico Nayara: "Janela de MFA recente configurável por risco... verificação
 * recente válida por X minutos, não uma verificação por sessão inteira").
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: o Caderno não define ONDE nem POR
 * QUANTO TEMPO essa janela vive. Duas opções óbvias eram (a) reaproveitar "core"."sessions"
 * adicionando uma coluna mfa_verified_at, ou (b) uma tabela dedicada. Optamos por (b): o JWT
 * de acesso (ver src/utils/jwt.js) NÃO carrega session_id nas claims hoje (só sub/group_id/
 * company_id/roles/permissions), então amarrar step-up a uma sessão exigiria mudar o formato
 * do token — mudança maior, fora do escopo pedido. Uma tabela dedicada por user_id (linha
 * única, upsert a cada `verify` bem-sucedido) é mais simples e não exige alterar login/refresh.
 * A duração da janela (10 minutos, ver MFA_STEP_UP_TTL_MINUTES em mfa.service.js) também é
 * decisão nossa — o Caderno só diz "configurável por risco", sem valor numérico; deixamos
 * um único TTL configurável por env por ora (não um TTL por nível de risco), documentado como
 * simplificação a validar com o cliente antes de produção.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'mfa_step_ups', schema: 'core' },
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
        verified_at: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        expires_at: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "core"."mfa_step_ups" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "core"."mfa_step_ups" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "core"."mfa_step_ups"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "core"."mfa_step_ups";');
    await queryInterface.sequelize.query('ALTER TABLE "core"."mfa_step_ups" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'mfa_step_ups', schema: 'core' });
  },
};
