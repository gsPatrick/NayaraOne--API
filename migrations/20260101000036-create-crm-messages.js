'use strict';

/** Migration: cria "crm"."messages" — Mensagem de atendimento omnichannel (WhatsApp etc.), vinculada a uma pessoa/oportunidade. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'messages', schema: 'crm' },
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
          allowNull: true,
          references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        opportunity_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'opportunities', schema: 'crm' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        channel: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'WHATSAPP',
        },
        direction: {
          type: Sequelize.STRING(16),
          allowNull: false,
        },
        author_type: {
          type: Sequelize.STRING(16),
          allowNull: false,
        },
        author_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        body: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'RECEIVED',
        },
        external_message_id: {
          type: Sequelize.STRING(128),
          allowNull: true,
          unique: true,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "crm"."messages" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "crm"."messages" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "crm"."messages"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "crm"."messages";');
    await queryInterface.sequelize.query('ALTER TABLE "crm"."messages" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'messages', schema: 'crm' });
  },
};
