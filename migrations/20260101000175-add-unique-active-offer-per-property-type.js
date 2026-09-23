'use strict';

/**
 * Constraint única PARCIAL: no máximo 1 "real_estate"."property_offers" com status='ACTIVE'
 * por (property_id, offer_type).
 *
 * DECISÃO DE ENGENHARIA — achado real na auditoria adversarial de corrida (23/09/2026), mesmo
 * padrão já corrigido em person_addresses (migration 20260101000174): createOffer/updateOffer
 * chamam supersedeCurrentActiveOffer, que faz um UPDATE em massa (status=SUPERSEDED WHERE
 * property_id=X AND offer_type=Y AND status=ACTIVE) seguido de um INSERT/UPDATE incondicional
 * da offer nova como ACTIVE. Mesmo com `lock: transaction.LOCK.UPDATE` na leitura das offers
 * ACTIVE existentes (corrigido nesta mesma auditoria), isso só serializa quando JÁ existe uma
 * linha ACTIVE pra travar. Se ainda não existe nenhuma offer ACTIVE do tipo (ex.: primeira
 * oferta de venda de um imóvel), não há o que travar — duas criações concorrentes (dois
 * corretores) inserem duas offers ACTIVE ao mesmo tempo, violando a invariante de negócio.
 * Só uma constraint no banco garante "no máximo 1 ACTIVE por (property_id, offer_type)" sob
 * concorrência real.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX property_offers_one_active_per_property_type_uk
      ON "real_estate"."property_offers" (property_id, offer_type)
      WHERE status = 'ACTIVE';
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "real_estate"."property_offers_one_active_per_property_type_uk";');
  },
};
