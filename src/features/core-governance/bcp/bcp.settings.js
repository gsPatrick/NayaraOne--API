'use strict';

const { govError } = require('../governance.errors');
const { SECTOR_CODES } = require('./bcp.constants');

/**
 * Parâmetros do BCP (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.bcp.setor_por_papel (M9-D830 §3.0b): JSON { "SETOR": ["NOME DO PAPEL", ...] }. O setor do usuário vem do NOME do papel que ele tem na empresa (sem diferenciar
 *    maiúsculas); o papel ADMIN pertence aos seis. Os nomes iniciais são os de uso comum; o administrador troca pelos da sua empresa.
 *  - governanca.bcp.listagem_limite: máximo de operações por página em GET /bcp/manual-operations (padrão 100).
 *  - governanca.bcp.impressao_max_folhas (M9-D834 §3.3): máximo de folhas numeradas por impressão de formulário (padrão 500).
 *  - governanca.bcp.importacao_lote_max (M9-D832): máximo de operações por pedido de importação (padrão 200).
 *  - governanca.bcp.importacao_lead_prazo_horas (M9-D832): prazo, em horas, do próximo contato de um lead importado do papel (padrão 24).
 */
const SECTOR_ROLES_KEY = 'governanca.bcp.setor_por_papel';
const LIST_LIMIT_KEY = 'governanca.bcp.listagem_limite';
const PRINT_MAX_KEY = 'governanca.bcp.impressao_max_folhas';
const IMPORT_BATCH_MAX_KEY = 'governanca.bcp.importacao_lote_max';
const IMPORT_LEAD_HOURS_KEY = 'governanca.bcp.importacao_lead_prazo_horas';

const DEFAULT_SECTOR_ROLES = Object.freeze({
  ATENDIMENTO: ['ATENDIMENTO', 'ATENDENTE', 'CORRETOR', 'RECEPCAO'],
  LOCACAO: ['LOCACAO', 'LOCAÇÃO', 'LOCADOR'],
  FINANCEIRO: ['FINANCEIRO'],
  OBRAS: ['OBRAS', 'ENGENHARIA', 'MESTRE DE OBRAS'],
  CORRESPONDENTE: ['CORRESPONDENTE'],
  JURIDICO: ['JURIDICO', 'JURÍDICO'],
});

const BCP_SETTING_DEFAULTS = Object.freeze({
  [SECTOR_ROLES_KEY]: JSON.stringify(DEFAULT_SECTOR_ROLES),
  [LIST_LIMIT_KEY]: 100,
  [PRINT_MAX_KEY]: 500,
  [IMPORT_BATCH_MAX_KEY]: 200,
  [IMPORT_LEAD_HOURS_KEY]: 24,
});

/** Texto JSON -> { SETOR: [NOME MAIÚSCULO] } ou null se estiver fora do formato (chaves só entre os seis setores; valores listas de textos não vazios). */
function parseSectorRoles(text) {
  let parsed;
  try { parsed = typeof text === 'string' ? JSON.parse(text) : text; } catch (_e) { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out = {};
  for (const [sector, names] of Object.entries(parsed)) {
    if (!SECTOR_CODES.includes(sector) || !Array.isArray(names)) return null;
    if (names.some((name) => typeof name !== 'string' || !name.trim())) return null;
    out[sector] = names.map((name) => name.trim().toUpperCase());
  }
  return out;
}

function validateSectorRoles(key, value) {
  if (!parseSectorRoles(value)) {
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser um JSON { "SETOR": ["PAPEL", ...] } com setores entre ${SECTOR_CODES.join(', ')}.`, { key });
  }
}

const BCP_SETTINGS_SCHEMA = {
  [SECTOR_ROLES_KEY]: { type: 'string', validate: validateSectorRoles },
  [LIST_LIMIT_KEY]: { type: 'integer', min: 1, max: 1000 },
  [PRINT_MAX_KEY]: { type: 'integer', min: 1, max: 5000 },
  [IMPORT_BATCH_MAX_KEY]: { type: 'integer', min: 1, max: 1000 },
  [IMPORT_LEAD_HOURS_KEY]: { type: 'integer', min: 1, max: 720 },
};

module.exports = { SECTOR_ROLES_KEY, LIST_LIMIT_KEY, PRINT_MAX_KEY, IMPORT_BATCH_MAX_KEY, IMPORT_LEAD_HOURS_KEY, DEFAULT_SECTOR_ROLES, BCP_SETTING_DEFAULTS, BCP_SETTINGS_SCHEMA, parseSectorRoles };
