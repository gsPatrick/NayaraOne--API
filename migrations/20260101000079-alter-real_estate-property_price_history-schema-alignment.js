'use strict';

/**
 * Migration: alinha "real_estate"."property_price_history" ao schema confirmado.
 *
 * O Caderno Técnico confirma que o histórico de preço é vinculado à OFERTA, não ao imóvel
 * físico ("Venda e locação são ofertas; não duplicar imóvel físico"). O model anterior tinha
 * property_id (NOT NULL) + property_offer_id (NULL) — invertemos: offer_id passa a ser a FK
 * única e obrigatória, property_id é removida.
 *
 * Linhas pré-existentes sem property_offer_id preenchido (não deveria haver nenhuma em
 * dev/teste, já que Marco 3 não foi formalmente aceito) são removidas antes do NOT NULL, pois
 * não há como inferir uma oferta retroativamente para um registro append-only órfão.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(
      `DELETE FROM "real_estate"."property_price_history" WHERE property_offer_id IS NULL;`
    );
    await queryInterface.changeColumn(
      { tableName: 'property_price_history', schema: 'real_estate' },
      'property_offer_id',
      { type: Sequelize.UUID, allowNull: false }
    );
    await queryInterface.renameColumn({ tableName: 'property_price_history', schema: 'real_estate' }, 'property_offer_id', 'offer_id');
    await queryInterface.removeColumn({ tableName: 'property_price_history', schema: 'real_estate' }, 'property_id');

    await queryInterface.renameColumn({ tableName: 'property_price_history', schema: 'real_estate' }, 'previous_price', 'old_price');

    await queryInterface.addColumn(
      { tableName: 'property_price_history', schema: 'real_estate' },
      'reason_code',
      { type: Sequelize.STRING(50), allowNull: false, defaultValue: 'PRICE_UPDATE' }
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "real_estate"."property_price_history" ALTER COLUMN reason_code DROP DEFAULT;`
    );

    await queryInterface.renameColumn(
      { tableName: 'property_price_history', schema: 'real_estate' },
      'changed_by_user_id',
      'changed_by'
    );
    await queryInterface.changeColumn(
      { tableName: 'property_price_history', schema: 'real_estate' },
      'changed_by',
      { type: Sequelize.UUID, allowNull: false }
    );

    await queryInterface.sequelize.query(`
      CREATE INDEX property_price_history_offer_id_changed_at_idx
        ON "real_estate"."property_price_history" (offer_id, changed_at DESC);
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "real_estate".property_price_history_offer_id_changed_at_idx;');
    await queryInterface.changeColumn(
      { tableName: 'property_price_history', schema: 'real_estate' },
      'changed_by',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.renameColumn(
      { tableName: 'property_price_history', schema: 'real_estate' },
      'changed_by',
      'changed_by_user_id'
    );
    await queryInterface.removeColumn({ tableName: 'property_price_history', schema: 'real_estate' }, 'reason_code');
    await queryInterface.renameColumn({ tableName: 'property_price_history', schema: 'real_estate' }, 'old_price', 'previous_price');
    await queryInterface.addColumn(
      { tableName: 'property_price_history', schema: 'real_estate' },
      'property_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'properties', schema: 'real_estate' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.renameColumn({ tableName: 'property_price_history', schema: 'real_estate' }, 'offer_id', 'property_offer_id');
    await queryInterface.changeColumn(
      { tableName: 'property_price_history', schema: 'real_estate' },
      'property_offer_id',
      { type: Sequelize.UUID, allowNull: true }
    );
  },
};
