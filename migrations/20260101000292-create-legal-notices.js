'use strict';

/**
 * Migration: auditoria externa (contrato bruto, Anexo I "4. Entidades/tabelas obrigatórias" +
 * "13. Aditivos e notificações") — "legal.notices: Notificações." / "Notificação possui canal,
 * destinatário, conteúdo/arquivo, data e evidência de envio/recebimento quando disponível." /
 * "IA pode rascunhar; envio jurídico sensível requer revisão humana." Esta entidade não existia
 * — vinculada a um Contract OU a um LegalCase (nunca os dois, nunca nenhum).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable({ tableName: 'notices', schema: 'legal' }, {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      group_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      company_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      contract_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'contracts', schema: 'legal' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      legal_case_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'legal_cases', schema: 'legal' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      channel: { type: Sequelize.STRING(32), allowNull: false }, // EMAIL|WHATSAPP|POSTAL_MAIL|IN_PERSON|OTHER
      recipient_person_id: { type: Sequelize.UUID, allowNull: true },
      recipient_description: { type: Sequelize.TEXT, allowNull: true },
      content: { type: Sequelize.TEXT, allowNull: true },
      content_file_id: { type: Sequelize.UUID, allowNull: true },
      is_legally_sensitive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      // DRAFT|PENDING_REVIEW|APPROVED|SENT|DELIVERED|REJECTED
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'DRAFT' },
      drafted_by_ai: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      reviewed_by_user_id: { type: Sequelize.UUID, allowNull: true },
      reviewed_at: { type: Sequelize.DATE, allowNull: true },
      sent_at: { type: Sequelize.DATE, allowNull: true },
      sent_by_user_id: { type: Sequelize.UUID, allowNull: true },
      delivery_evidence_file_id: { type: Sequelize.UUID, allowNull: true },
      delivered_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.UUID, allowNull: true },
      updated_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      deleted_at: { type: Sequelize.DATE, allowNull: true },
    });

    await queryInterface.addIndex({ tableName: 'notices', schema: 'legal' }, ['contract_id']);
    await queryInterface.addIndex({ tableName: 'notices', schema: 'legal' }, ['legal_case_id']);

    await queryInterface.sequelize.query('ALTER TABLE "legal"."notices" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."notices" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."notices"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
    await queryInterface.sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "legal"."notices" TO nayara_runtime;');
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: 'notices', schema: 'legal' });
  },
};
