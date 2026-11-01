'use strict';

/**
 * Parâmetros de SEGURANÇA da governança (M9-D870, reabertura R4-L1): chaves que, afrouxadas por quem só tem `settings:update`, desligam ou enfraquecem uma proteção do livro
 * (relógio e escopo da migração, módulos de governança, retenção, permissões e MFA, prazo de descarte do dado pessoal, justificativa mínima do DLP, limite de requisições, níveis de confirmação, risco padrão das flags).
 * Cada família exige a permissão do dono da regra, além de `settings:update`. As chaves da migração (`migracao.`) ficam em `migration.gateKeys` (governance:migration:admin).
 * O registro de flags não declara estas permissões, salvo a dele próprio (governance:flags:manage, que a rota já exigiu).
 */
const FAMILIES = Object.freeze([
  { permission: 'governance:dlp:admin', matches: (key) => key.startsWith('governanca.dlp.') },
  { permission: 'governance:api:manage', matches: (key) => key.startsWith('governanca.api.rate_limit.') || key.startsWith('governanca.api.cliente.') },
  { permission: 'governance:flags:manage', matches: (key) => key === 'governanca.ui.confirmacao_por_nivel' || key === 'governanca.ui.exibir_debug' || key.startsWith('governanca.flags.') || key.startsWith('governanca.acoes.') || key.startsWith('governanca.calendario.permissao_por_') },
  // M9-D870 R5-M1/R5-L4: ligar/desligar módulo de governança (o DLP desligado tira a máscara da empresa) exige o dono do módulo; prazos, degradação, permissões e MFA também.
  { permission: null, matches: (key) => MODULE_KEY.test(key), ownerOf: (key) => MODULE_OWNERS[MODULE_KEY.exec(key)[1]] || 'governance:flags:manage' },
  { permission: 'governance:retention:manage', matches: (key) => key.startsWith('governanca.retencao.') },
  { permission: 'governance:classification:manage', matches: (key) => key.startsWith('governanca.ia.') || key.startsWith('governanca.dados.classificacao.') || key.startsWith('governanca.dados.evidencia.') },
  { permission: 'governance:finops:manage', matches: (key) => key.startsWith('governanca.finops.degradacao.') },
  { permission: 'governance:legal-hold:manage', matches: (key) => key.startsWith('governanca.legal_hold.') },
  { permission: 'roles:update', matches: (key) => key.startsWith('governanca.permissoes.') || key === 'mfa.step_up_ttl_minutes' || key === 'mfa.required_for_sensitive_roles' },
]);

const MODULE_KEY = /^governanca\.modulos\.([a-z_]+)\.habilitado$/;
const MODULE_OWNERS = Object.freeze({
  dlp: 'governance:dlp:admin', feature_flags: 'governance:flags:manage', api_governance: 'governance:api:manage', finops: 'governance:finops:manage',
  lineage: 'governance:lineage:manage', data_quality: 'governance:data-quality:manage', bcp: 'governance:bcp:approve', calendar: 'governance:flags:manage',
});

/** Permissão do dono da regra para a chave de segurança (ou null). */
function securityPermissionOf(key) {
  const family = FAMILIES.find((f) => f.matches(String(key)));
  if (!family) return null;
  return family.ownerOf ? family.ownerOf(String(key)) : family.permission;
}

module.exports = { securityPermissionOf };
