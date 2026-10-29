'use strict';

/**
 * Parâmetros da NAY configurados pelo administrador em /painel/configuracoes (aba IA NAY). Mesmo padrão do projeto:
 * dicionário fail-closed em SETTINGS_SCHEMA (settings.service.js faz o spread de AI_SETTINGS_SCHEMA) + getSetting(chave,
 * tenant, transaction, padrão). O padrão é o valor inicial de Maturacao/demandas/parametros.csv. Cada demanda do bloco A
 * acrescenta as suas chaves neste arquivo.
 */
const { AGENT_SETTING_DEFAULTS, AGENT_SETTINGS_SCHEMA } = require('./agents/agents.settings');
const { RUN_SETTING_DEFAULTS, RUN_SETTINGS_SCHEMA } = require('./orchestrator/runs/runs.settings');
const { SECURITY_SETTING_DEFAULTS, SECURITY_SETTINGS_SCHEMA } = require('./orchestrator/security.settings');
const { GROUNDING_SETTING_DEFAULTS, GROUNDING_SETTINGS_SCHEMA } = require('./orchestrator/grounding/grounding.settings');
const { PRIVACY_SETTING_DEFAULTS, PRIVACY_SETTINGS_SCHEMA } = require('./security/privacy.settings');
const { TOOLCALL_SETTING_DEFAULTS, TOOLCALL_SETTINGS_SCHEMA } = require('./tools/toolCalls.settings');
const { ARGS_SETTING_DEFAULTS, ARGS_SETTINGS_SCHEMA } = require('./tools/args.settings');
const { INJECTION_SETTING_DEFAULTS, INJECTION_SETTINGS_SCHEMA } = require('./security/injection.settings');
const { RETENTION_SETTING_DEFAULTS, RETENTION_SETTINGS_SCHEMA } = require('./retention/retention.settings');
const { AUDIT_SETTING_DEFAULTS, AUDIT_SETTINGS_SCHEMA } = require('./audit/audit.settings');
const { RECOMMENDATION_SETTING_DEFAULTS, RECOMMENDATION_SETTINGS_SCHEMA } = require('./recommendations/recommendation.settings');
const { EVALUATION_SETTING_DEFAULTS, EVALUATION_SETTINGS_SCHEMA } = require('./evaluations/evaluations.settings');
const { BUDGET_SETTING_DEFAULTS, BUDGET_SETTINGS_SCHEMA } = require('./budgets/budgets.settings');
const { APPROVAL_SETTING_DEFAULTS, APPROVAL_SETTINGS_SCHEMA } = require('./approval/approval.settings');
const { PROVIDER_SETTING_DEFAULTS, PROVIDER_SETTINGS_SCHEMA } = require('./providers/providers.settings');
const { MEMORY_SETTING_DEFAULTS, MEMORY_SETTINGS_SCHEMA } = require('./memory/memory.settings');
const { REGRESSION_SETTING_DEFAULTS, REGRESSION_SETTINGS_SCHEMA } = require('./regression/regression.settings');
const { ROUTER_SETTING_DEFAULTS, ROUTER_SETTINGS_SCHEMA } = require('./providers/router/router.settings');
const { FALLBACK_SETTING_DEFAULTS, FALLBACK_SETTINGS_SCHEMA } = require('./providers/fallback/fallback.settings');
const { FLOW_SETTING_DEFAULTS, FLOW_SETTINGS_SCHEMA } = require('./orchestrator/flow/flow.settings');
const { RAG_SETTING_DEFAULTS, RAG_SETTINGS_SCHEMA } = require('./retrieval/retrieval.settings');
const { RUN_API_SETTING_DEFAULTS, RUN_API_SETTINGS_SCHEMA } = require('./runApi/runApi.settings');

const AI_ENABLED_KEY = 'ia.habilitada';
const AI_AGENTS_ENABLED_KEY = 'ai.agents.enabled';

/** Chaves que só quem tem ai:admin altera (além de settings:update). */
const AI_SETTING_PREFIXES = Object.freeze(['ia.', 'ai.']);

const AI_SETTING_DEFAULTS = Object.freeze({
  // Desligado enquanto o status do livro for PRONTO PARA LAB (seção 17): a NAY só roda onde o administrador a liga.
  [AI_ENABLED_KEY]: false,
  // "*" = todos os agentes; ou lista de códigos separados por vírgula (só esses rodam; os demais respondem 409).
  [AI_AGENTS_ENABLED_KEY]: '*',
  ...AGENT_SETTING_DEFAULTS,
  ...RUN_SETTING_DEFAULTS,
  ...SECURITY_SETTING_DEFAULTS,
  ...GROUNDING_SETTING_DEFAULTS,
  ...PRIVACY_SETTING_DEFAULTS,
  ...TOOLCALL_SETTING_DEFAULTS,
  ...ARGS_SETTING_DEFAULTS,
  ...INJECTION_SETTING_DEFAULTS,
  ...RETENTION_SETTING_DEFAULTS,
  ...AUDIT_SETTING_DEFAULTS,
  ...RECOMMENDATION_SETTING_DEFAULTS,
  ...EVALUATION_SETTING_DEFAULTS,
  ...BUDGET_SETTING_DEFAULTS,
  ...APPROVAL_SETTING_DEFAULTS,
  ...PROVIDER_SETTING_DEFAULTS,
  ...MEMORY_SETTING_DEFAULTS,
  ...ROUTER_SETTING_DEFAULTS,
  ...FALLBACK_SETTING_DEFAULTS,
  ...FLOW_SETTING_DEFAULTS,
  ...RAG_SETTING_DEFAULTS,
  ...RUN_API_SETTING_DEFAULTS,
});
  ...REGRESSION_SETTING_DEFAULTS,

const AI_SETTINGS_SCHEMA = {
  [AI_ENABLED_KEY]: { type: 'boolean' },
  [AI_AGENTS_ENABLED_KEY]: { type: 'string' },
  ...AGENT_SETTINGS_SCHEMA,
  ...RUN_SETTINGS_SCHEMA,
  ...SECURITY_SETTINGS_SCHEMA,
  ...GROUNDING_SETTINGS_SCHEMA,
  ...PRIVACY_SETTINGS_SCHEMA,
  ...TOOLCALL_SETTINGS_SCHEMA,
  ...ARGS_SETTINGS_SCHEMA,
  ...INJECTION_SETTINGS_SCHEMA,
  ...RETENTION_SETTINGS_SCHEMA,
  ...AUDIT_SETTINGS_SCHEMA,
  ...RECOMMENDATION_SETTINGS_SCHEMA,
  ...EVALUATION_SETTINGS_SCHEMA,
  ...BUDGET_SETTINGS_SCHEMA,
  ...APPROVAL_SETTINGS_SCHEMA,
  ...PROVIDER_SETTINGS_SCHEMA,
  ...MEMORY_SETTINGS_SCHEMA,
  ...ROUTER_SETTINGS_SCHEMA,
  ...FALLBACK_SETTINGS_SCHEMA,
  ...FLOW_SETTINGS_SCHEMA,
  ...RAG_SETTINGS_SCHEMA,
  ...RUN_API_SETTINGS_SCHEMA,
};

function isAiSettingKey(key) {
  ...REGRESSION_SETTINGS_SCHEMA,
  return typeof key === 'string' && AI_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** "*" ou "A, b" -> { all: true } | { all: false, codes: Set('A','B') } (maiúsculas). */
function parseAgentList(text) {
  const source = typeof text === 'string' && text.trim() ? text : AI_SETTING_DEFAULTS[AI_AGENTS_ENABLED_KEY];
  const items = source.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
  if (items.includes('*')) return { all: true, codes: new Set() };
  return { all: false, codes: new Set(items) };
}

module.exports = {
  AI_ENABLED_KEY,
  AI_AGENTS_ENABLED_KEY,
  AI_SETTING_DEFAULTS,
  AI_SETTINGS_SCHEMA,
  isAiSettingKey,
  parseAgentList,
};
