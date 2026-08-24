'use strict';

/**
 * Migration: alinha "real_estate"."property_offers" ao schema confirmado.
 * - offer_type: varchar(16) -> varchar(30) (para acomodar 'SEASONAL').
 * - price_amount -> asking_price (mesma semântica: preço público/atual).
 * - adiciona confidential_min_price (NUNCA exposto em endpoint público — aplicado em
 *   propertyOffers.service.js/serializer, não em constraint de banco).
 * - adiciona accepts_financing, accepts_trade (booleans, NULL permitido).
 * - adiciona INDEX(property_id, status) confirmado pelo documento.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn(
      { tableName: 'property_offers', schema: 'real_estate' },
      'offer_type',
      { type: Sequelize.STRING(30), allowNull: false }
    );
    await queryInterface.renameColumn({ tableName: 'property_offers', schema: 'real_estate' }, 'price_amount', 'asking_price');

    await queryInterface.addColumn(
      { tableName: 'property_offers', schema: 'real_estate' },
      'confidential_min_price',
      { type: Sequelize.DECIMAL(18, 2), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'property_offers', schema: 'real_estate' },
      'accepts_financing',
      { type: Sequelize.BOOLEAN, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'property_offers', schema: 'real_estate' },
      'accepts_trade',
      { type: Sequelize.BOOLEAN, allowNull: true }
    );

    await queryInterface.sequelize.query(`
      CREATE INDEX property_offers_property_id_status_idx
        ON "real_estate"."property_offers" (property_id, status);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "real_estate".property_offers_property_id_status_idx;');
    await queryInterface.removeColumn({ tableName: 'property_offers', schema: 'real_estate' }, 'accepts_trade');
    await queryInterface.removeColumn({ tableName: 'property_offers', schema: 'real_estate' }, 'accepts_financing');
    await queryInterface.removeColumn({ tableName: 'property_offers', schema: 'real_estate' }, 'confidential_min_price');
    await queryInterface.renameColumn({ tableName: 'property_offers', schema: 'real_estate' }, 'asking_price', 'price_amount');
  },
};
