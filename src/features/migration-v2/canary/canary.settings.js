'use strict';

const { govError } = require('../../core-governance/governance.errors');
const { SECTOR_CODES } = require('./canary.constants');

/**
 * Parâmetros do canary por setor (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv):
 *  - migracao.canary.etapas (P9-EF-069): percentuais de usuários do setor no sistema novo, em ordem crescente e terminando em 100 (padrão 5,25,50,100).
 *  - migracao.canary.exigir_comparacao: o avanço exige uma comparação paralela (M9-D903) concluída e limpa para cada entidade migrável do setor (padrão ligado).
 *  - migracao.setor.<setor>.entidades: entidades cujos blockers da Torre (M9-D901) pertencem ao setor (lista separada por vírgula).
 */
const STAGES_KEY = 'migracao.canary.etapas';
const REQUIRE_COMPARISON_KEY = 'migracao.canary.exigir_comparacao';
const entitiesKey = (sector) => `migracao.setor.${sector.toLowerCase()}.entidades`;

// Nomes de entidade da migração (check mig_sources_entity_chk, M9-D900): o livro dá os assuntos de cada setor, não os nomes técnicos. CORRESPONDENTE ainda não tem entidade de migração: o nome é o do assunto.
const DEFAULT_ENTITIES = Object.freeze({
  ATENDIMENTO: 'LEAD,VISIT',
  LOCACAO: 'PROPOSAL,CONTRACT',
  FINANCEIRO: 'FINANCIAL_ENTRY',
  OBRAS: 'PROJECT,PROJECT_STAGE',
  CORRESPONDENTE: 'FINANCING_PROCESS',
  JURIDICO: 'LEGAL_DEADLINE,LEGAL_CASE',
});

const CANARY_SETTING_DEFAULTS = Object.freeze({
  [STAGES_KEY]: '5,25,50,100',
  [REQUIRE_COMPARISON_KEY]: true,
  ...Object.fromEntries(SECTOR_CODES.map((sector) => [entitiesKey(sector), DEFAULT_ENTITIES[sector]])),
});

/** "5, 25,50 ,100" -> [5,25,50,100] ou null se estiver fora do formato (inteiros de 1 a 100, estritamente crescentes, terminando em 100). */
function parseStages(text) {
  const parts = String(text == null ? '' : text).split(',').map((part) => part.trim());
  if (!parts.length || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const stages = parts.map(Number);
  if (stages.some((n, i) => n < 1 || n > 100 || (i > 0 && n <= stages[i - 1])) || stages[stages.length - 1] !== 100) return null;
  return stages;
}

/** "lead, Visit" -> ['LEAD','VISIT'] ou null (cada entidade: letras, dígitos e _; ao menos uma). */
function parseEntities(text) {
  const parts = String(text == null ? '' : text).split(',').map((part) => part.trim().toUpperCase()).filter(Boolean);
  if (!parts.length || parts.some((part) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(part))) return null;
  return [...new Set(parts)];
}

const validateStages = (key, value) => {
  if (!parseStages(value)) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser uma lista de percentuais inteiros de 1 a 100, em ordem crescente e terminando em 100 (por exemplo 5,25,50,100).`, { key });
};
const validateEntities = (key, value) => {
  if (!parseEntities(value)) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser uma lista de nomes de entidade separados por vírgula (letras, dígitos e _).`, { key });
};

const CANARY_SETTINGS_SCHEMA = {
  [STAGES_KEY]: { type: 'string', validate: validateStages },
  [REQUIRE_COMPARISON_KEY]: { type: 'boolean' },
  ...Object.fromEntries(SECTOR_CODES.map((sector) => [entitiesKey(sector), { type: 'string', validate: validateEntities }])),
};

module.exports = { STAGES_KEY, REQUIRE_COMPARISON_KEY, entitiesKey, DEFAULT_ENTITIES, CANARY_SETTING_DEFAULTS, CANARY_SETTINGS_SCHEMA, parseStages, parseEntities };
