'use strict';

/**
 * Marco 9, M9-D201 — catálogo inicial das 14 famílias de integração (seed de dados, idempotente).
 *
 * 1. Os providers que o Correspondente já tinha (`sandbox`, `manual`) viram `financing-sandbox` e
 *    `financing-manual`: o UPDATE do código propaga para integration.connections (FK ON UPDATE CASCADE).
 *    A criticidade deles passa à da família FINANCING (CRITICAL).
 * 2. Seed dos 14 sandboxes + financing-manual + signature-clicksign (`catalog.seed`): só atualiza
 *    display_name, capabilities e supported_versions; nunca status nem default_policy_json.
 */
const { seedCatalog } = require('../src/features/integrations/providers/catalog.seed');

const RENAMES = [['sandbox', 'financing-sandbox'], ['manual', 'financing-manual']];

module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      for (const [antigo, novo] of RENAMES) {
        await sequelize.query(
          `UPDATE "integration"."providers" SET code = :novo, criticality = 'CRITICAL', updated_at = now()
            WHERE code = :antigo AND NOT EXISTS (SELECT 1 FROM "integration"."providers" WHERE code = :novo)`,
          { transaction, replacements: { antigo, novo } }
        );
      }
      await seedCatalog(sequelize, transaction);
    });
  },

  // Seed de dados: o down não apaga nada (conexões podem já apontar para os códigos novos).
  down: async () => {},
};
