'use strict';

/**
 * Parâmetros da NAY configurados pelo administrador em /painel/configuracoes (aba IA NAY). Mesmo padrão do projeto:
 * dicionário fail-closed em SETTINGS_SCHEMA (settings.service.js faz o spread de AI_SETTINGS_SCHEMA) + getSetting(chave,
 * tenant, transaction, padrão). O padrão é o valor inicial de Maturacao/demandas/parametros.csv. Cada demanda do bloco A
 * acrescenta as suas chaves neste arquivo.
 */
const { AGENT_SETTING_DEFAULTS, AGENT_SETTINGS_SCHEMA } = require('./agents/agents.settings');
const { RUN_SETTING_DEFAULTS, RUN_SETTINGS_SCHEMA } = require('./orchestrator/runs/runs.settings');

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
});

const AI_SETTINGS_SCHEMA = {
  [AI_ENABLED_KEY]: { type: 'boolean' },
  [AI_AGENTS_ENABLED_KEY]: { type: 'string' },
  ...AGENT_SETTINGS_SCHEMA,
  ...RUN_SETTINGS_SCHEMA,
};

function isAiSettingKey(key) {
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
