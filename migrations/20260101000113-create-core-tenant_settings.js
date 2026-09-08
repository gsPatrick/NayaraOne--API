'use strict';

/**
 * Migration: cria "core"."tenant_settings" — painel admin de configuração por tenant, usado
 * para tornar ajustáveis valores hoje hardcoded no código (marcados como "DECISÃO DE
 * ENGENHARIA — não especificado no Caderno"), ex.: percentual de multa/juros de atraso
 * (REG-LOC-001), carência (REG-LOC-002), índice de reajuste padrão, janela de MFA recente.
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: o Caderno não define o desenho de
 * tabela para um painel de configurações por empresa. Seguimos o mesmo formato chave/valor
 * já usado por "core"."system_settings" (group_id/company_id/key/value JSONB) — mas em uma
 * tabela própria (`tenant_settings`) em vez de reaproveitar `system_settings`, porque esta
 * última já existe sem uso em produção e sem UNIQUE(company_id, key)/schema validado; criar
 * uma tabela nova com essas garantias (UNIQUE + schema de valores em código, ver
 * settings.service.js SETTINGS_SCHEMA) evita conflito com qualquer uso futuro de
 * system_settings e deixa claro que esta tabela é o backend do módulo settings novo.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'tenant_settings', schema: 'core' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
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
        key: { type: Sequelize.STRING(128), allowNull: false },
        value: { type: Sequelize.JSONB, allowNull: false },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addConstraint(
      { tableName: 'tenant_settings', schema: 'core' },
      {
        fields: ['company_id', 'key'],
        type: 'unique',
        name: 'tenant_settings_company_id_key_unique',
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "core"."tenant_settings" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "core"."tenant_settings" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "core"."tenant_settings"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "core"."tenant_settings";');
    await queryInterface.sequelize.query('ALTER TABLE "core"."tenant_settings" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'tenant_settings', schema: 'core' });
  },
};
