'use strict';

/**
 * Migration: alinha "real_estate"."properties" ao schema confirmado pelo Caderno Técnico
 * (Marco 3 ainda não formalmente aceito — ALTER incremental sobre a tabela já existente em vez
 * de recriar do zero, preservando o histórico de migrations já rodadas, seguindo o mesmo padrão
 * de decisão já registrado em outras migrations incrementais deste projeto).
 *
 * - Adiciona internal_code, address_id (FK para property_addresses), registry_number,
 *   registry_office, latitude, longitude, publication_status, availability_status.
 * - Remove a coluna "status" única (esquema antigo) — substituída por publication_status +
 *   availability_status (não podem coexistir, conforme instrução explícita da alinhamento).
 * - internal_code é populado com um placeholder derivado do id para linhas pré-existentes
 *   (não deve haver nenhuma em dev/teste ainda, mas a migration precisa ser segura de qualquer
 *   forma) e só então recebe NOT NULL + UNIQUE(group_id, internal_code).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'properties', schema: 'real_estate' },
      'address_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'property_addresses', schema: 'real_estate' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );

    await queryInterface.addColumn(
      { tableName: 'properties', schema: 'real_estate' },
      'internal_code',
      { type: Sequelize.STRING(40), allowNull: true }
    );
    await queryInterface.sequelize.query(
      `UPDATE "real_estate"."properties" SET internal_code = substr(id::text, 1, 8) WHERE internal_code IS NULL;`
    );
    await queryInterface.changeColumn(
      { tableName: 'properties', schema: 'real_estate' },
      'internal_code',
      { type: Sequelize.STRING(40), allowNull: false }
    );
    await queryInterface.addIndex(
      { tableName: 'properties', schema: 'real_estate' },
      ['group_id', 'internal_code'],
      { unique: true, name: 'properties_group_id_internal_code_uk' }
    );

    await queryInterface.addColumn(
      { tableName: 'properties', schema: 'real_estate' },
      'registry_number',
      { type: Sequelize.STRING(100), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'properties', schema: 'real_estate' },
      'registry_office',
      { type: Sequelize.STRING(150), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'properties', schema: 'real_estate' },
      'latitude',
      { type: Sequelize.DECIMAL(10, 7), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'properties', schema: 'real_estate' },
      'longitude',
      { type: Sequelize.DECIMAL(10, 7), allowNull: true }
    );

    await queryInterface.addColumn(
      { tableName: 'properties', schema: 'real_estate' },
      'publication_status',
      { type: Sequelize.STRING(30), allowNull: false, defaultValue: 'DRAFT' }
    );
    await queryInterface.addColumn(
      { tableName: 'properties', schema: 'real_estate' },
      'availability_status',
      { type: Sequelize.STRING(30), allowNull: false, defaultValue: 'AVAILABLE' }
    );
    await queryInterface.sequelize.query(
      `UPDATE "real_estate"."properties" SET availability_status = status WHERE status IS NOT NULL;`
    );
    await queryInterface.removeColumn({ tableName: 'properties', schema: 'real_estate' }, 'status');

    await queryInterface.sequelize.query(`
      CREATE INDEX properties_group_id_registry_number_idx
        ON "real_estate"."properties" (group_id, registry_number)
        WHERE registry_number IS NOT NULL;
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "real_estate".properties_group_id_registry_number_idx;');
    await queryInterface.addColumn(
      { tableName: 'properties', schema: 'real_estate' },
      'status',
      { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'AVAILABLE' }
    );
    await queryInterface.sequelize.query(
      `UPDATE "real_estate"."properties" SET status = availability_status;`
    );
    await queryInterface.removeColumn({ tableName: 'properties', schema: 'real_estate' }, 'availability_status');
    await queryInterface.removeColumn({ tableName: 'properties', schema: 'real_estate' }, 'publication_status');
    await queryInterface.removeColumn({ tableName: 'properties', schema: 'real_estate' }, 'longitude');
    await queryInterface.removeColumn({ tableName: 'properties', schema: 'real_estate' }, 'latitude');
    await queryInterface.removeColumn({ tableName: 'properties', schema: 'real_estate' }, 'registry_office');
    await queryInterface.removeColumn({ tableName: 'properties', schema: 'real_estate' }, 'registry_number');
    await queryInterface.removeIndex({ tableName: 'properties', schema: 'real_estate' }, 'properties_group_id_internal_code_uk');
    await queryInterface.removeColumn({ tableName: 'properties', schema: 'real_estate' }, 'internal_code');
    await queryInterface.removeColumn({ tableName: 'properties', schema: 'real_estate' }, 'address_id');
  },
};
