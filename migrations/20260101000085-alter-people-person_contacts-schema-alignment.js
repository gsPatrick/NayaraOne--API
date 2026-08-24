'use strict';

/**
 * Migration: alinha "people"."person_contacts" ao schema confirmado (TAB-0102).
 * - channel -> contact_type (varchar(30)); enum FECHADO confirmado: PHONE, WHATSAPP, EMAIL.
 * - value -> value_normalized (varchar(254)).
 * - adiciona consent_status (varchar(30), NULL) e verified_at (timestamptz, NULL).
 * - adiciona os índices confirmados: INDEX(person_id, is_primary) e INDEX(value_normalized).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.renameColumn({ tableName: 'person_contacts', schema: 'people' }, 'channel', 'contact_type');
    await queryInterface.changeColumn(
      { tableName: 'person_contacts', schema: 'people' },
      'contact_type',
      { type: Sequelize.STRING(30), allowNull: false }
    );

    await queryInterface.renameColumn({ tableName: 'person_contacts', schema: 'people' }, 'value', 'value_normalized');
    await queryInterface.changeColumn(
      { tableName: 'person_contacts', schema: 'people' },
      'value_normalized',
      { type: Sequelize.STRING(254), allowNull: false }
    );

    await queryInterface.addColumn(
      { tableName: 'person_contacts', schema: 'people' },
      'consent_status',
      { type: Sequelize.STRING(30), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'person_contacts', schema: 'people' },
      'verified_at',
      { type: Sequelize.DATE, allowNull: true }
    );

    await queryInterface.addIndex(
      { tableName: 'person_contacts', schema: 'people' },
      ['person_id', 'is_primary'],
      { name: 'person_contacts_person_id_is_primary_idx' }
    );
    await queryInterface.addIndex(
      { tableName: 'person_contacts', schema: 'people' },
      ['value_normalized'],
      { name: 'person_contacts_value_normalized_idx' }
    );
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeIndex({ tableName: 'person_contacts', schema: 'people' }, 'person_contacts_value_normalized_idx');
    await queryInterface.removeIndex({ tableName: 'person_contacts', schema: 'people' }, 'person_contacts_person_id_is_primary_idx');

    await queryInterface.removeColumn({ tableName: 'person_contacts', schema: 'people' }, 'verified_at');
    await queryInterface.removeColumn({ tableName: 'person_contacts', schema: 'people' }, 'consent_status');

    await queryInterface.changeColumn(
      { tableName: 'person_contacts', schema: 'people' },
      'value_normalized',
      { type: Sequelize.STRING(255), allowNull: false }
    );
    await queryInterface.renameColumn({ tableName: 'person_contacts', schema: 'people' }, 'value_normalized', 'value');

    await queryInterface.changeColumn(
      { tableName: 'person_contacts', schema: 'people' },
      'contact_type',
      { type: Sequelize.STRING(16), allowNull: false }
    );
    await queryInterface.renameColumn({ tableName: 'person_contacts', schema: 'people' }, 'contact_type', 'channel');
  },
};
