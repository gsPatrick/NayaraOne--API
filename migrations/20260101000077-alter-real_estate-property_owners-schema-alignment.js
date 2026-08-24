'use strict';

/**
 * Migration: alinha "real_estate"."property_owners" ao schema confirmado.
 * - ownership_pct (numeric(9,6)) -> ownership_percent (numeric(7,4), NULL permitido).
 * - starts_at/ends_at (timestamptz) -> valid_from/valid_until (date).
 * - adiciona role_code (OWNER|USUFRUCTUARY, mínimo confirmado pelo Caderno; mantemos o domínio
 *   aberto em varchar(30) para admitir outros papéis já usados no app, se existirem).
 * - adiciona INDEX(property_id, valid_until) confirmado pelo documento.
 * PK própria (uuid) do model atual é mantida — o documento não lista PK explícita para esta
 * tabela, então preservamos a PK já existente (decisão documentada).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.renameColumn({ tableName: 'property_owners', schema: 'real_estate' }, 'ownership_pct', 'ownership_percent');
    await queryInterface.changeColumn(
      { tableName: 'property_owners', schema: 'real_estate' },
      'ownership_percent',
      { type: Sequelize.DECIMAL(7, 4), allowNull: true, defaultValue: null }
    );

    await queryInterface.renameColumn({ tableName: 'property_owners', schema: 'real_estate' }, 'starts_at', 'valid_from');
    await queryInterface.renameColumn({ tableName: 'property_owners', schema: 'real_estate' }, 'ends_at', 'valid_until');
    await queryInterface.changeColumn(
      { tableName: 'property_owners', schema: 'real_estate' },
      'valid_from',
      { type: Sequelize.DATEONLY, allowNull: true }
    );
    await queryInterface.changeColumn(
      { tableName: 'property_owners', schema: 'real_estate' },
      'valid_until',
      { type: Sequelize.DATEONLY, allowNull: true }
    );

    await queryInterface.addColumn(
      { tableName: 'property_owners', schema: 'real_estate' },
      'role_code',
      { type: Sequelize.STRING(30), allowNull: false, defaultValue: 'OWNER' }
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "real_estate"."property_owners" ALTER COLUMN role_code DROP DEFAULT;`
    );

    await queryInterface.sequelize.query(`
      CREATE INDEX property_owners_property_id_valid_until_idx
        ON "real_estate"."property_owners" (property_id, valid_until);
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "real_estate".property_owners_property_id_valid_until_idx;');
    await queryInterface.removeColumn({ tableName: 'property_owners', schema: 'real_estate' }, 'role_code');
    await queryInterface.changeColumn(
      { tableName: 'property_owners', schema: 'real_estate' },
      'valid_until',
      { type: Sequelize.DATE, allowNull: true }
    );
    await queryInterface.changeColumn(
      { tableName: 'property_owners', schema: 'real_estate' },
      'valid_from',
      { type: Sequelize.DATE, allowNull: true }
    );
    await queryInterface.renameColumn({ tableName: 'property_owners', schema: 'real_estate' }, 'valid_until', 'ends_at');
    await queryInterface.renameColumn({ tableName: 'property_owners', schema: 'real_estate' }, 'valid_from', 'starts_at');
    await queryInterface.changeColumn(
      { tableName: 'property_owners', schema: 'real_estate' },
      'ownership_percent',
      { type: Sequelize.DECIMAL(9, 6), allowNull: false, defaultValue: 100 }
    );
    await queryInterface.renameColumn({ tableName: 'property_owners', schema: 'real_estate' }, 'ownership_percent', 'ownership_pct');
  },
};
