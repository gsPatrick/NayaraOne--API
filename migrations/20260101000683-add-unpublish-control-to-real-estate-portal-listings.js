'use strict';

/**
 * Marco 9, M9-D233 — controle da despublicação nos portais. real_estate.portal_listings ganha: o momento do pedido de remoção, os reenvios já feitos (até o máximo configurado),
 * o instante da próxima conferência do job de reconciliação e o momento em que as tentativas se esgotaram (tarefa urgente e alerta uma única vez).
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "real_estate"."portal_listings"
      ADD COLUMN IF NOT EXISTS unpublish_requested_at timestamptz,
      ADD COLUMN IF NOT EXISTS unpublish_attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS unpublish_next_attempt_at timestamptz,
      ADD COLUMN IF NOT EXISTS unpublish_exhausted_at timestamptz;`);
    await q('CREATE INDEX IF NOT EXISTS portal_listings_unpublishing_idx ON "real_estate"."portal_listings" (company_id, unpublish_next_attempt_at) WHERE status = \'UNPUBLISHING\' AND superseded_at IS NULL;');
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP INDEX IF EXISTS "real_estate".portal_listings_unpublishing_idx;');
    await q(`ALTER TABLE "real_estate"."portal_listings" DROP COLUMN IF EXISTS unpublish_exhausted_at, DROP COLUMN IF EXISTS unpublish_next_attempt_at, DROP COLUMN IF EXISTS unpublish_attempts, DROP COLUMN IF EXISTS unpublish_requested_at;`);
  },
};
