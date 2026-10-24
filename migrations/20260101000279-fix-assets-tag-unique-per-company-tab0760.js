'use strict';

/**
 * Rodada 47 — auditoria "loop até secar" (2026-10-05): TAB-0760 exige UNIQUE(company_id,
 * asset_tag) — o schema real tinha só UNIQUE(asset_tag) global, bloqueando reaproveitar a
 * mesma tag física em empresas distintas do mesmo tenant.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."assets" DROP CONSTRAINT IF EXISTS "assets_asset_tag_key";');
    await queryInterface.addIndex(
      { tableName: 'assets', schema: 'inventory' },
      ['company_id', 'asset_tag'],
      { name: 'assets_company_id_asset_tag_unique', unique: true, where: { asset_tag: { [Sequelize.Op.ne]: null } } }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex({ tableName: 'assets', schema: 'inventory' }, 'assets_company_id_asset_tag_unique');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."assets" ADD CONSTRAINT "assets_asset_tag_key" UNIQUE (asset_tag);');
  },
};
