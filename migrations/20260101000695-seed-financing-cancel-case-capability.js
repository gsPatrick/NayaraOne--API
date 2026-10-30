'use strict';

/**
 * Marco 9, M9-D240 + M9-D220 — os dois adapters de financiamento (financing-sandbox e financing-manual) passam a declarar a capability `cancelCase`, a compensação do `submitCase`
 * (o caso que o provider aceitou depois de o Correspondente tê-lo dado por encerrado é cancelado por um NOVO envio). Seed idempotente: só nome, capabilities e versões; nunca
 * sobrescreve status, política nem criticidade alterados pelo administrador.
 */
module.exports = {
  up: async (queryInterface) => {
    const { seedCatalog } = require('../src/features/integrations/providers/catalog.seed');
    const { SEED_PROVIDERS } = require('../src/features/integrations/providers/catalog.providers');
    await queryInterface.sequelize.transaction((transaction) => seedCatalog(queryInterface.sequelize, transaction, SEED_PROVIDERS.filter((p) => ['financing-sandbox', 'financing-manual'].includes(p.code))));
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`UPDATE "integration"."providers" SET capabilities = capabilities - 'cancelCase', updated_at = now() WHERE code IN ('financing-sandbox', 'financing-manual');`);
  },
};
