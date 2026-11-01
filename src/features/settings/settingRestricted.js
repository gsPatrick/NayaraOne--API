'use strict';

/**
 * Parâmetros com permissão própria além de `settings:update` (M9-D870 R3-M1): as chaves da NAY (ai:admin) e as metas de SLO das integrações (integration:manage) e os parâmetros do portão do corte da migração (governance:migration:admin, M9-D908 R3-L3).
 * A rota PUT /settings confere a permissão do token; o registro de flags (PATCH /feature-flags com gravação nos parâmetros) não declara essas permissões e por isso
 * não pode escrever nelas: `restrictedPermissionOf` diz qual permissão a chave exige (ou null) para quem precisa recusar o caminho que não a traz.
 * As áreas donas das regras são carregadas sob demanda para não criar ciclo com o serviço de parâmetros.
 */
const { securityPermissionOf } = require('./settingSecurity');

const RULES = Object.freeze([
  { permission: 'ai:admin', matches: (key) => require('../ai/ai.settings').isAiSettingKey(key) },
  { permission: 'integration:manage', matches: (key) => require('../integrations/health/slo').isSloSettingKey(key) },
  { permission: 'governance:migration:admin', matches: (key) => require('../migration-v2/migration.gateKeys').isMigrationGateKey(key) },
]);

/** Permissão extra que a chave exige (ou null quando ela é comum). */
function restrictedPermissionOf(key) {
  const rule = RULES.find((r) => r.matches(String(key)));
  return rule ? rule.permission : securityPermissionOf(key);
}

module.exports = { restrictedPermissionOf };
