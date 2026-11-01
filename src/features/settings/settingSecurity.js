'use strict';

/**
 * Parâmetros de SEGURANÇA da governança (M9-D870, reabertura R4-L1): chaves que, afrouxadas por quem só tem `settings:update`, desligam ou enfraquecem uma proteção do livro
 * (relógio e escopo da migração, prazo de descarte do dado pessoal, justificativa mínima do DLP, limite de requisições, níveis de confirmação, risco padrão das flags).
 * Cada família exige a permissão do dono da regra, além de `settings:update`. As chaves da migração (`migracao.`) ficam em `migration.gateKeys` (governance:migration:admin).
 * O registro de flags não declara estas permissões, salvo a dele próprio (governance:flags:manage, que a rota já exigiu).
 */
const FAMILIES = Object.freeze([
  { permission: 'governance:dlp:admin', matches: (key) => key.startsWith('governanca.dlp.') },
  { permission: 'governance:api:manage', matches: (key) => key.startsWith('governanca.api.rate_limit.') || key.startsWith('governanca.api.cliente.') },
  { permission: 'governance:flags:manage', matches: (key) => key === 'governanca.ui.confirmacao_por_nivel' || key === 'governanca.ui.exibir_debug' || key.startsWith('governanca.flags.') },
]);

/** Permissão do dono da regra para a chave de segurança (ou null). */
function securityPermissionOf(key) {
  const family = FAMILIES.find((f) => f.matches(String(key)));
  return family ? family.permission : null;
}

module.exports = { securityPermissionOf };
