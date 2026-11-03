'use strict';

/**
 * Marco 9, M9-D242 — catálogo: o armazenamento de objetos e a identidade passam a ter os drivers reais do sistema atrás do port.
 *  - storage-sandbox ganha getSignedUrl e identity-sandbox ganha listJwks (as capabilities extras de D201 que a D242 implementa);
 *  - entram storage-local-disk (disco do servidor), storage-s3 (S3 compatível) e identity-local (autenticação própria).
 * Seed idempotente (só nome, capabilities e versões; nunca sobrescreve status, política nem criticidade alterados pelo administrador).
 */
const CODIGOS = ['storage-sandbox', 'identity-sandbox', 'storage-local-disk', 'storage-s3', 'identity-local'];

module.exports = {
  up: async (queryInterface) => {
    const { seedCatalog } = require('../src/features/integrations/providers/catalog.seed');
    const { SEED_PROVIDERS } = require('../src/features/integrations/providers/catalog.providers');
    await queryInterface.sequelize.transaction((transaction) => seedCatalog(queryInterface.sequelize, transaction, SEED_PROVIDERS.filter((p) => CODIGOS.includes(p.code))));
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    // providers_no_delete (migration 650) barra DELETE; o seed só remove o que ele mesmo inseriu, então o gatilho é suspenso só aqui
    await queryInterface.sequelize.query('ALTER TABLE "integration"."providers" DISABLE TRIGGER providers_no_delete');
    await q("DELETE FROM \"integration\".\"providers\" p WHERE p.code IN ('storage-local-disk', 'storage-s3', 'identity-local') AND NOT EXISTS (SELECT 1 FROM \"integration\".\"connections\" c WHERE c.provider_code = p.code);");
    await queryInterface.sequelize.query('ALTER TABLE "integration"."providers" ENABLE TRIGGER providers_no_delete');
    await q("UPDATE \"integration\".\"providers\" SET capabilities = '[\"putObject\",\"getObject\",\"deleteObject\",\"headObject\"]'::jsonb WHERE code = 'storage-sandbox';");
    await q("UPDATE \"integration\".\"providers\" SET capabilities = '[\"verifyToken\",\"getUserInfo\",\"revokeSession\"]'::jsonb WHERE code = 'identity-sandbox';");
  },
};
