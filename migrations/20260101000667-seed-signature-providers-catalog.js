'use strict';

/**
 * Marco 9, M9-D236 — catálogo dos fornecedores de assinatura: ZapSign e o sandbox alternativo entram; sandbox e Clicksign passam a declarar também `downloadSigned`.
 * Seed idempotente (INSERT ... ON CONFLICT só de nome, capabilities e versões; nunca sobrescreve status, política nem criticidade alterados pelo administrador).
 */
const CODIGOS = ['signature-sandbox', 'signature-clicksign', 'signature-zapsign', 'signature-alt-sandbox'];

module.exports = {
  up: async (queryInterface) => {
    const { seedCatalog } = require('../src/features/integrations/providers/catalog.seed');
    const { SEED_PROVIDERS } = require('../src/features/integrations/providers/catalog.providers');
    await queryInterface.sequelize.transaction((transaction) => seedCatalog(queryInterface.sequelize, transaction, SEED_PROVIDERS.filter((p) => CODIGOS.includes(p.code))));
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query("DELETE FROM \"integration\".\"providers\" WHERE code IN ('signature-zapsign', 'signature-alt-sandbox') AND NOT EXISTS (SELECT 1 FROM \"integration\".\"connections\" c WHERE c.provider_code IN ('signature-zapsign', 'signature-alt-sandbox'));");
  },
};
