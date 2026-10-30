'use strict';

/**
 * Marco 9, M9-D229 — catálogo da mensageria: entra o segundo fornecedor de laboratório (`messaging-alt-sandbox`, sem sendMedia), que prova a troca de provider (M9-D221).
 * Seed idempotente (INSERT ... ON CONFLICT só de nome, capabilities e versões; nunca sobrescreve status, política nem criticidade alterados pelo administrador).
 */
const CODIGOS = ['messaging-alt-sandbox'];

module.exports = {
  up: async (queryInterface) => {
    const { seedCatalog } = require('../src/features/integrations/providers/catalog.seed');
    const { SEED_PROVIDERS } = require('../src/features/integrations/providers/catalog.providers');
    await queryInterface.sequelize.transaction((transaction) => seedCatalog(queryInterface.sequelize, transaction, SEED_PROVIDERS.filter((p) => CODIGOS.includes(p.code))));
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query("DELETE FROM \"integration\".\"providers\" WHERE code = 'messaging-alt-sandbox' AND NOT EXISTS (SELECT 1 FROM \"integration\".\"connections\" c WHERE c.provider_code = 'messaging-alt-sandbox');");
  },
};
