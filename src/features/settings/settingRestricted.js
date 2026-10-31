'use strict';

/**
 * Parâmetros com permissão própria além de `settings:update` (M9-D870 R3-M1): as chaves da NAY (ai:admin) e as metas de SLO das integrações (integration:manage).
 * A rota PUT /settings confere a permissão do token; o registro de flags (PATCH /feature-flags com gravação nos parâmetros) não declara essas permissões e por isso
 * não pode escrever nelas: `restrictedPermissionOf` diz qual permissão a chave exige (ou null) para quem precisa recusar o caminho que não a traz.
 * As áreas donas das regras são carregadas sob demanda para não criar ciclo com o serviço de parâmetros.
 */
const RULES = Object.freeze([
  { permission: 'ai:admin', matches: (key) => require('../ai/ai.settings').isAiSettingKey(key) },
  { permission: 'integration:manage', matches: (key) => require('../integrations/health/slo').isSloSettingKey(key) },
]);

/** Permissão extra que a chave exige (ou null quando ela é comum). */
function restrictedPermissionOf(key) {
  const rule = RULES.find((r) => r.matches(String(key)));
  return rule ? rule.permission : null;
}

module.exports = { restrictedPermissionOf };
