'use strict';

const { mktError } = require('../marketing.errors');

/**
 * M9-D420 e M9-D421 — parâmetros das automações de entrada do funil (aba Marketing de Configurações; padrão = Maturacao/demandas/parametros.csv). O dicionário
 * fail-closed fica em SETTINGS_SCHEMA (settings.service.js faz o spread de LEAD_PARAMS_SCHEMA) e quem usa lê por getSetting na hora, sem cache:
 *  - lead novo: prazo da tarefa de contato (min) e origens que disparam a confirmação;
 *  - cliente frio: dias sem interação, máximo de mensagens e janela móvel (a fonte única do limite de nutrição) e tipos de conteúdo aprovado que a nutrição envia.
 */
const LEAD_DEADLINE_KEY = 'marketing.lead_novo.prazo_contato_min';
const LEAD_ORIGINS_KEY = 'marketing.lead_novo.origens';
const COLD_INACTIVITY_KEY = 'marketing.cliente_frio.dias_inatividade';
const COLD_MAX_KEY = 'marketing.cliente_frio.max_mensagens';
const COLD_WINDOW_KEY = 'marketing.cliente_frio.janela_dias';
const COLD_CONTENT_TYPES_KEY = 'marketing.cliente_frio.tipos_conteudo';

const LEAD_PARAM_DEFAULTS = Object.freeze({
  [LEAD_DEADLINE_KEY]: 60, [LEAD_ORIGINS_KEY]: 'FORM, SITE, PORTAL, WHATSAPP', [COLD_INACTIVITY_KEY]: 60, [COLD_MAX_KEY]: 4, [COLD_WINDOW_KEY]: 90, [COLD_CONTENT_TYPES_KEY]: 'EDUCATIONAL_BLOG',
});

/** Parâmetros numéricos que o cap da versão pode referenciar (`maxParam` e `windowDaysParam`): lista fechada. */
const CAP_PARAM_KEYS = Object.freeze([COLD_MAX_KEY, COLD_WINDOW_KEY]);

const NAME_LIST_RE = /^[A-Z][A-Z0-9_]*$/;

/** "form, Site" -> ['FORM','SITE']; texto sem nenhum item válido devolve null. */
function parseNameList(text) {
  if (typeof text !== 'string') return null;
  const items = text.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  return items.length > 0 && items.every((i) => NAME_LIST_RE.test(i)) ? [...new Set(items)] : null;
}

function validateNames(key, value) {
  if (!parseNameList(value)) throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: 'nomes separados por vírgula (letras maiúsculas, números e _), ex.: FORM, SITE' });
}

const LEAD_PARAMS_SCHEMA = {
  [LEAD_DEADLINE_KEY]: { type: 'integer', min: 1, max: 10080 },
  [LEAD_ORIGINS_KEY]: { type: 'string', validate: validateNames },
  [COLD_INACTIVITY_KEY]: { type: 'integer', min: 1, max: 3650 },
  [COLD_MAX_KEY]: { type: 'integer', min: 1, max: 100 },
  [COLD_WINDOW_KEY]: { type: 'integer', min: 1, max: 3650 },
  [COLD_CONTENT_TYPES_KEY]: { type: 'string', validate: validateNames },
};

/** Lê um parâmetro numérico positivo da empresa; ausente ou ilegível volta ao padrão registrado. */
async function readLeadInt(key, tenant, transaction) {
  const { getSetting } = require('../../settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const value = Number(await getSetting(key, tenant, transaction, LEAD_PARAM_DEFAULTS[key]));
  return Number.isInteger(value) && value >= 1 ? value : LEAD_PARAM_DEFAULTS[key];
}

async function readLeadNames(key, tenant, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  return parseNameList(String(await getSetting(key, tenant, transaction, LEAD_PARAM_DEFAULTS[key]))) || parseNameList(LEAD_PARAM_DEFAULTS[key]);
}

module.exports = {
  LEAD_DEADLINE_KEY, LEAD_ORIGINS_KEY, COLD_INACTIVITY_KEY, COLD_MAX_KEY, COLD_WINDOW_KEY, COLD_CONTENT_TYPES_KEY, LEAD_PARAM_DEFAULTS, LEAD_PARAMS_SCHEMA, CAP_PARAM_KEYS, parseNameList, readLeadInt, readLeadNames,
};
