'use strict';

/**
 * Marco 9, M9-D238 — catálogo das seguradoras: Porto Seguro, Yelum, Junto Seguros e o fluxo manual entram; o sandbox passa a declarar também `verifyWebhook` (o webhook de
 * status pela caixa de entrada). Seed idempotente (INSERT ... ON CONFLICT só de nome, capabilities e versões; nunca sobrescreve status, política nem criticidade alterados pelo administrador).
 */
const CODIGOS = ['insurance-sandbox', 'insurance-porto-seguro', 'insurance-yelum', 'insurance-junto-seguros', 'insurance-manual'];

module.exports = {
  up: async (queryInterface) => {
    const { seedCatalog } = require('../src/features/integrations/providers/catalog.seed');
    const { SEED_PROVIDERS } = require('../src/features/integrations/providers/catalog.providers');
    await queryInterface.sequelize.transaction((transaction) => seedCatalog(queryInterface.sequelize, transaction, SEED_PROVIDERS.filter((p) => CODIGOS.includes(p.code))));
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query("UPDATE \"integration\".\"providers\" SET capabilities = '[\"quote\",\"propose\",\"getPolicy\",\"getStatus\"]'::jsonb WHERE code = 'insurance-sandbox';");
    await queryInterface.sequelize.query("DELETE FROM \"integration\".\"providers\" WHERE code IN ('insurance-porto-seguro', 'insurance-yelum', 'insurance-junto-seguros', 'insurance-manual') AND NOT EXISTS (SELECT 1 FROM \"integration\".\"connections\" c WHERE c.provider_code IN ('insurance-porto-seguro', 'insurance-yelum', 'insurance-junto-seguros', 'insurance-manual'));");
  },
};
