'use strict';

const { CALENDAR_SETTING_DEFAULTS, CALENDAR_SETTINGS_SCHEMA } = require('./calendar/calendar.settings');
const { DATA_QUALITY_SETTING_DEFAULTS, DATA_QUALITY_SETTINGS_SCHEMA } = require('./data-quality/data-quality.settings');
const { LINEAGE_SETTING_DEFAULTS, LINEAGE_SETTINGS_SCHEMA } = require('./lineage/lineage.settings');
const { DLP_SETTING_DEFAULTS, DLP_SETTINGS_SCHEMA } = require('./dlp/dlp.settings');
const { BCP_SETTING_DEFAULTS, BCP_SETTINGS_SCHEMA } = require('./bcp/bcp.settings');
const { HOLIDAYS_DEFAULTS, HOLIDAYS_SCHEMA } = require('./calendar/holidays.settings');
const { STANDARDS_SETTING_DEFAULTS, STANDARDS_SETTINGS_SCHEMA } = require('./api-governance/standards/standards.settings');
const { CONSUMERS_SETTING_DEFAULTS, CONSUMERS_SETTINGS_SCHEMA } = require('./api-governance/consumers/consumers.settings');
const { CLIENTS_SETTING_DEFAULTS, CLIENTS_SETTINGS_SCHEMA } = require('./api-governance/clients/clients.settings');
const { UI_SETTING_DEFAULTS, UI_SETTINGS_SCHEMA } = require('./governance.ui.settings');
const { FINOPS_SETTING_DEFAULTS, FINOPS_SETTINGS_SCHEMA } = require('./finops/finops.settings');
const { FLAGS_SETTING_DEFAULTS, FLAGS_SETTINGS_SCHEMA } = require('./feature-flags/flags.settings');
const { PARALLEL_SETTINGS_SCHEMA } = require('../migration-v2/parallel/parallel.settings');
const { CANARY_SETTINGS_SCHEMA } = require('../migration-v2/canary/canary.settings');
const { ROLLBACK_SETTINGS_SCHEMA } = require('../migration-v2/rollback/rollback.settings');
const { CLOCK_SETTINGS_SCHEMA } = require('../migration-v2/clock/clock.settings');
const { TIMEZONE_SETTINGS_SCHEMA } = require('../migration-v2/timezone/timezone.settings');
const { DRY_SETTINGS_SCHEMA } = require('../migration-v2/dryrun/dry.settings');
const { INGEST_SETTINGS_SCHEMA } = require('../migration-v2/ingest/ingest.settings'); // chaves migracao.*: os padrões ficam em ingest.settings (o catálogo de defaults abaixo é só de governanca.*)

/**
 * Parâmetros do bloco de governança que o administrador configura na tela /painel/configuracoes (aba Governança).
 * Mesmo padrão do restante do projeto: dicionário fail-closed em SETTINGS_SCHEMA (settings.service.js, que faz o spread de
 * GOVERNANCE_SETTINGS_SCHEMA) + leitura por getSetting(chave, tenant, transaction, padrão). O padrão aqui é o valor inicial
 * do catálogo (Maturacao/demandas/parametros.csv). Cada demanda do bloco acrescenta as suas chaves neste arquivo.
 */

/** Os 8 módulos do livro: código da pasta, prefixo de rota e chave de configuração (sem hífen). */
const GOVERNANCE_MODULES = Object.freeze([
  { code: 'calendar', prefix: '/calendar', label: 'Calendário unificado' },
  { code: 'data-quality', prefix: '/data-quality', label: 'Dados mestres e qualidade' },
  { code: 'lineage', prefix: '/data-lineage', label: 'Linhagem de dados' },
  { code: 'dlp', prefix: '/dlp', label: 'Proteção contra vazamento (DLP)' },
  { code: 'bcp', prefix: '/bcp', label: 'Continuidade operacional (BCP)' },
  { code: 'api-governance', prefix: '/api-governance', label: 'Governança de API' },
  { code: 'finops', prefix: '/finops', label: 'FinOps' },
  { code: 'feature-flags', prefix: '/feature-flags', label: 'Feature flags e configuração' },
]);

function moduleSettingKey(code) {
  return `governanca.modulos.${code.replace(/-/g, '_')}.habilitado`;
}

const ERRORS_EXCEPTIONS_KEY = 'governanca.erros.excecoes_prefixo_gov';
const PROFILES_MANAGEMENT_KEY = 'governanca.permissoes.perfis_gestao';
const PROFILES_FINANCE_KEY = 'governanca.permissoes.perfis_financeiro';

const GOVERNANCE_SETTING_DEFAULTS = {
  ...CALENDAR_SETTING_DEFAULTS,
  ...DATA_QUALITY_SETTING_DEFAULTS,
  ...LINEAGE_SETTING_DEFAULTS,
  ...DLP_SETTING_DEFAULTS,
  ...BCP_SETTING_DEFAULTS,
  ...HOLIDAYS_DEFAULTS,
  ...STANDARDS_SETTING_DEFAULTS,
  ...CONSUMERS_SETTING_DEFAULTS,
  ...CLIENTS_SETTING_DEFAULTS,
  ...UI_SETTING_DEFAULTS,
  ...FINOPS_SETTING_DEFAULTS,
  ...FLAGS_SETTING_DEFAULTS,
  [ERRORS_EXCEPTIONS_KEY]: 'PERMISSION_DENIED, MISSING_ACCESS_TOKEN, MFA_STEP_UP_REQUIRED, MFA_REQUIRED_NOT_ENABLED, INTERNAL_ERROR, VALIDATION_ERROR, ROUTE_NOT_FOUND',
  [PROFILES_MANAGEMENT_KEY]: 'GESTAO, GESTÃO, DIRETOR, GERENTE, GESTOR',
  [PROFILES_FINANCE_KEY]: 'FINANCEIRO',
};
for (const mod of GOVERNANCE_MODULES) GOVERNANCE_SETTING_DEFAULTS[moduleSettingKey(mod.code)] = true;

const GOVERNANCE_SETTINGS_SCHEMA = {
  ...CALENDAR_SETTINGS_SCHEMA,
  ...DATA_QUALITY_SETTINGS_SCHEMA,
  ...LINEAGE_SETTINGS_SCHEMA,
  ...DLP_SETTINGS_SCHEMA,
  ...BCP_SETTINGS_SCHEMA,
  ...HOLIDAYS_SCHEMA,
  ...STANDARDS_SETTINGS_SCHEMA,
  ...CONSUMERS_SETTINGS_SCHEMA,
  ...CLIENTS_SETTINGS_SCHEMA,
  ...UI_SETTINGS_SCHEMA,
  ...FINOPS_SETTINGS_SCHEMA,
  ...FLAGS_SETTINGS_SCHEMA,
  ...INGEST_SETTINGS_SCHEMA,
  ...PARALLEL_SETTINGS_SCHEMA,
  ...CANARY_SETTINGS_SCHEMA,
  ...ROLLBACK_SETTINGS_SCHEMA,
  ...CLOCK_SETTINGS_SCHEMA,
  ...TIMEZONE_SETTINGS_SCHEMA,
  ...DRY_SETTINGS_SCHEMA,
  [ERRORS_EXCEPTIONS_KEY]: { type: 'string' },
  [PROFILES_MANAGEMENT_KEY]: { type: 'string' },
  [PROFILES_FINANCE_KEY]: { type: 'string' },
};
for (const mod of GOVERNANCE_MODULES) GOVERNANCE_SETTINGS_SCHEMA[moduleSettingKey(mod.code)] = { type: 'boolean' };

/** "A, B , c" -> ['A','B','C'] (maiúsculas, sem vazios); usado nas listas de perfis. */
function parseNameList(text, fallback) {
  const source = typeof text === 'string' && text.trim() ? text : fallback;
  return String(source).split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
}

module.exports = {
  GOVERNANCE_MODULES,
  GOVERNANCE_SETTING_DEFAULTS,
  GOVERNANCE_SETTINGS_SCHEMA,
  ERRORS_EXCEPTIONS_KEY,
  PROFILES_MANAGEMENT_KEY,
  PROFILES_FINANCE_KEY,
  moduleSettingKey,
  parseNameList,
};
