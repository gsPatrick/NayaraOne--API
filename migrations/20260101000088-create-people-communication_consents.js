'use strict';

/**
 * Migration: cria "people"."communication_consents" — Registro de opt-in/opt-out de
 * comunicação por pessoa/canal/finalidade (regra CRMX-008: "Comunicação respeita opt-in/opt-out
 * e finalidade").
 *
 * O Caderno confirma apenas o NOME da tabela, sem detalhar colunas — lacuna documentada. A
 * estrutura abaixo (channel/purpose/status/recorded_at) é INFERÊNCIA razoável dado o contexto
 * de CRMX-008: channel reaproveita o enum fechado de person_contacts.contact_type
 * (PHONE/WHATSAPP/EMAIL); purpose é lista aberta (ex.: MARKETING, TRANSACTIONAL,
 * LEGAL_NOTICE); status é OPT_IN ou OPT_OUT.
 *
 * group_id/company_id próprios seguem o padrão de RLS direto (policy única "tenant_isolation")
 * já usado em todas as demais tabelas "people".*.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'communication_consents', schema: 'people' },
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
          allowNull: false,
          references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        channel: { type: Sequelize.STRING(30), allowNull: false, comment: 'PHONE|WHATSAPP|EMAIL' },
        purpose: { type: Sequelize.STRING(50), allowNull: false, comment: 'MARKETING|TRANSACTIONAL|LEGAL_NOTICE (lista aberta)' },
        status: { type: Sequelize.STRING(20), allowNull: false, comment: 'OPT_IN|OPT_OUT' },
        recorded_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addIndex(
      { tableName: 'communication_consents', schema: 'people' },
      ['person_id', 'channel', 'purpose'],
      { name: 'communication_consents_person_channel_purpose_idx' }
    );

    await queryInterface.sequelize.query('ALTER TABLE "people"."communication_consents" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "people"."communication_consents" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "people"."communication_consents"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "people"."communication_consents";');
    await queryInterface.sequelize.query('ALTER TABLE "people"."communication_consents" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'communication_consents', schema: 'people' });
  },
};
