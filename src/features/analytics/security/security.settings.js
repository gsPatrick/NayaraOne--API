'use strict';

/**
 * M9-D700 / M9-D687 — parâmetros de segurança do BI e do catálogo de painéis (a meta p95 NÃO é parâmetro: é a coluna dashboard_definitions.p95_target_ms, M9-D698) (aba "BI e Centro de Comando" em
 * /painel/configuracoes). Arquivo sem dependências: settings.service.js faz o spread do dicionário. Padrões em
 * Maturacao/demandas/parametros.csv. Quem lê: securityParams.js (getSetting); nenhum valor fixo no código além destes padrões.
 *
 * O mascaramento dos campos RESTRICTED do livro NÃO é configurável (nenhuma permissão o desliga); o administrador só
 * ACRESCENTA nomes de campo a mascarar.
 */
const KEYS = Object.freeze({
  DOMAIN_MAP: 'analytics.abac.mapa_dominio_permissao',
  TEAMS: 'analytics.abac.equipes',
  EXTRA_MASKED_FIELDS: 'analytics.mascaramento.campos_extras',
  PANEL_OPEN_LOG: 'analytics.log_acesso.abertura_painel',
  LOG_MAX_ROWS: 'analytics.log_acesso.consulta_max_linhas',
});

const NONE = 'nenhum';

const SECURITY_SETTING_DEFAULTS = Object.freeze({
  [KEYS.DOMAIN_MAP]: 'Financeiro=finance:read; Comercial/Imóveis=crm:opportunities:read; Marketing=marketing:attribution:read; Atendimento=crm:feedback:read; Locação e Jurídico=legal:read; Obras=construction:read; Estoque=inventory:read; Correspondente=correspondent:read; Tecnologia=analytics:read:tech',
  [KEYS.TEAMS]: NONE,
  [KEYS.EXTRA_MASKED_FIELDS]: NONE,
  [KEYS.PANEL_OPEN_LOG]: 'CRITICAL',
  [KEYS.LOG_MAX_ROWS]: 200,
});

const SECURITY_SETTINGS_SCHEMA = {
  [KEYS.DOMAIN_MAP]: { type: 'string' },
  [KEYS.TEAMS]: { type: 'string' },
  [KEYS.EXTRA_MASKED_FIELDS]: { type: 'string' },
  [KEYS.PANEL_OPEN_LOG]: { type: 'string', enum: ['CRITICAL', 'TODOS'] },
  [KEYS.LOG_MAX_ROWS]: { type: 'integer', min: 1, max: 1000 },
};

module.exports = { KEYS, NONE, SECURITY_SETTING_DEFAULTS, SECURITY_SETTINGS_SCHEMA };
