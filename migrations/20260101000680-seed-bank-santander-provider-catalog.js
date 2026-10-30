'use strict';

/**
 * Marco 9, M9-D237 — catálogo do banco Santander (PIX e boleto por mTLS): o adapter que já existia em finance/adapters/BankAdapter.js entra no registro de integrações
 * com as quatro capabilities do port BankAdapter. Seed idempotente (nunca sobrescreve status, política nem criticidade alterados pelo administrador).
 */
module.exports = {
  up: async (queryInterface) => {
    const { seedCatalog } = require('../src/features/integrations/providers/catalog.seed');
    const { SEED_PROVIDERS } = require('../src/features/integrations/providers/catalog.providers');
    await queryInterface.sequelize.transaction((transaction) => seedCatalog(queryInterface.sequelize, transaction, SEED_PROVIDERS.filter((p) => p.code === 'bank-santander')));
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query("DELETE FROM \"integration\".\"providers\" WHERE code = 'bank-santander' AND NOT EXISTS (SELECT 1 FROM \"integration\".\"connections\" c WHERE c.provider_code = 'bank-santander');");
  },
};
