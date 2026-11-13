'use strict';

/**
 * Parâmetros com permissão própria além de `settings:update` (M9-D870 R3-M1): as chaves de Marketing que ampliam o que sai da empresa (campos públicos: marketing:template:manage; cadência e autopublicação: marketing:automation:manage, M9-D403 e M9-D408 R4-M1), as chaves da NAY (ai:admin) e as metas de SLO das integrações (integration:manage) os parâmetros do portão do corte da migração (governance:migration:admin, M9-D908 R3-L3) e as chaves de freio de Marketing (URL, consentimento, supressão, restrição, kill switch, permissões e portão factual).
 * A rota PUT /settings confere a permissão do token; o registro de flags (PATCH /feature-flags com gravação nos parâmetros) não declara essas permissões e por isso
 * não pode escrever nelas: `restrictedPermissionOf` diz qual permissão a chave exige (ou null) para quem precisa recusar o caminho que não a traz.
 * As áreas donas das regras são carregadas sob demanda para não criar ciclo com o serviço de parâmetros.
 */
const { securityPermissionOf } = require('./settingSecurity');

const RULES = Object.freeze([
  { permission: 'ai:admin', matches: (key) => require('../ai/ai.settings').isAiSettingKey(key) },
  { permission: 'integration:manage', matches: (key) => require('../integrations/health/slo').isSloSettingKey(key) },
  { permission: 'marketing:template:manage', matches: (key) => require('../marketing/content/publicFields.settings').isPublicFieldsKey(key) },
  { permission: 'marketing:automation:manage', matches: (key) => require('../marketing/automations/cadence/cadence.settings').isCadenceFamilyKey(key) || key === require('../marketing/content/autopublish.settings').KEY },
  { permission: 'governance:migration:admin', matches: (key) => require('../migration-v2/migration.gateKeys').isMigrationGateKey(key) },
  // M9-D870 M-5 (rodada 5 de Marketing): as chaves de Marketing que abrem o que sai da empresa ou desligam um freio (política de URL, consentimento, supressão, restrição, kill switch, permissões e portão factual).
  { permission: 'marketing:automation:manage', matches: (key) => key.startsWith('marketing.url.') || key.startsWith('marketing.permissoes.') },
  { permission: 'marketing:suppression:manage', matches: (key) => key.startsWith('marketing.consent.') || key.startsWith('marketing.suppression.') || key.startsWith('marketing.restricao.') },
  { permission: 'marketing:killswitch:manage', matches: (key) => key.startsWith('marketing.killswitch') },
  { permission: 'marketing:content:approve', matches: (key) => key.startsWith('marketing.factual.') },
  // Marco 6: a base do custo realizado das obras muda a margem projetada e os bloqueios de margem — mesma alçada de quem aprova em Obras.
  { permission: 'construction:approve', matches: (key) => key.startsWith('construction.custo_realizado.') },
  // Verificação do Marco 6: evidências mínimas da medição e regra de diário ausente — mesma alçada de quem aprova em Obras.
  { permission: 'construction:approve', matches: (key) => key.startsWith('construction.medicao.') || key.startsWith('construction.diario_ausente.') },
]);

/** Permissão extra que a chave exige (ou null quando ela é comum). */
function restrictedPermissionOf(key) {
  const rule = RULES.find((r) => r.matches(String(key)));
  return rule ? rule.permission : securityPermissionOf(key);
}

module.exports = { restrictedPermissionOf };
