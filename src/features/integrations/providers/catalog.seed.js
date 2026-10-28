'use strict';

/**
 * Seed idempotente do catálogo (Marco 9, M9-D201, regra 1): `INSERT ... ON CONFLICT (code) DO UPDATE` só de
 * `display_name`, `capabilities` e `supported_versions`. Nunca sobrescreve `status`, `default_policy_json`,
 * `criticality`, `config_schema` nem `sandbox_available` alterados pelo administrador de plataforma.
 * Roda na migration 652 e pode ser repetida a qualquer momento (transação própria ou a do chamador).
 */
const { SEED_PROVIDERS } = require('./catalog.providers');

const SEED_SQL = `
INSERT INTO "integration"."providers"
  (code, display_name, domain, capabilities, supported_versions, criticality, status, sandbox_available, created_at, updated_at)
VALUES (:code, :displayName, :domain, CAST(:capabilities AS jsonb), CAST(:supportedVersions AS jsonb), :criticality, 'ACTIVE', :sandboxAvailable, now(), now())
ON CONFLICT (code) DO UPDATE
   SET display_name = EXCLUDED.display_name,
       capabilities = EXCLUDED.capabilities,
       supported_versions = EXCLUDED.supported_versions,
       updated_at = now()
RETURNING (xmax = 0) AS inserted
`;

async function seedCatalog(sequelize, transaction, providers = SEED_PROVIDERS) {
  let inserted = 0;
  for (const p of providers) {
    const [rows] = await sequelize.query(SEED_SQL, {
      transaction,
      replacements: {
        code: p.code, displayName: p.displayName, domain: p.domain, criticality: p.criticality,
        capabilities: JSON.stringify(p.capabilities), supportedVersions: JSON.stringify(p.supportedVersions),
        sandboxAvailable: p.sandboxAvailable,
      },
    });
    if (rows[0]?.inserted) inserted += 1;
  }
  return { total: providers.length, inserted };
}

module.exports = { seedCatalog, SEED_SQL };
