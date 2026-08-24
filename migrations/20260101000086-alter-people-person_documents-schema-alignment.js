'use strict';

/**
 * Migration: alinha "people"."person_documents" ao schema confirmado (TAB-0103).
 * - remove document_number (não confirmado na DDL; era inferência da implementação anterior).
 * - adiciona file_id (uuid, FK) — referencia "people"."files" (já existe desde a migration
 *   000027-create-people-files, que cobre exatamente o propósito "metadado de arquivo binário"
 *   citado para esta FK. Não há lacuna: a tabela genérica de arquivos já existia).
 * - adiciona version_no (integer, default 1), verification_status (varchar(30), default
 *   'PENDING', enum FECHADO confirmado: PENDING, VERIFIED, REJECTED), verified_by (uuid, NULL),
 *   extracted_data_json (jsonb, NULL).
 * - adiciona UNIQUE(person_id, document_type, version_no).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn({ tableName: 'person_documents', schema: 'people' }, 'document_number');

    await queryInterface.addColumn(
      { tableName: 'person_documents', schema: 'people' },
      'file_id',
      {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'files', schema: 'people' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'person_documents', schema: 'people' },
      'version_no',
      { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 }
    );
    await queryInterface.addColumn(
      { tableName: 'person_documents', schema: 'people' },
      'verification_status',
      { type: Sequelize.STRING(30), allowNull: false, defaultValue: 'PENDING' }
    );
    await queryInterface.addColumn(
      { tableName: 'person_documents', schema: 'people' },
      'verified_by',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'person_documents', schema: 'people' },
      'extracted_data_json',
      { type: Sequelize.JSONB, allowNull: true }
    );

    await queryInterface.addConstraint(
      { tableName: 'person_documents', schema: 'people' },
      {
        fields: ['person_id', 'document_type', 'version_no'],
        type: 'unique',
        name: 'person_documents_person_id_document_type_version_no_key',
      }
    );
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeConstraint(
      { tableName: 'person_documents', schema: 'people' },
      'person_documents_person_id_document_type_version_no_key'
    );

    await queryInterface.removeColumn({ tableName: 'person_documents', schema: 'people' }, 'extracted_data_json');
    await queryInterface.removeColumn({ tableName: 'person_documents', schema: 'people' }, 'verified_by');
    await queryInterface.removeColumn({ tableName: 'person_documents', schema: 'people' }, 'verification_status');
    await queryInterface.removeColumn({ tableName: 'person_documents', schema: 'people' }, 'version_no');
    await queryInterface.removeColumn({ tableName: 'person_documents', schema: 'people' }, 'file_id');

    await queryInterface.addColumn(
      { tableName: 'person_documents', schema: 'people' },
      'document_number',
      { type: Sequelize.STRING(64), allowNull: true }
    );
  },
};
