'use strict';

const AppError = require('../../../../utils/AppError');
const { FEATURE_CATALOG } = require('../publicFields.settings');
const { fold } = require('./text');

/**
 * M9-D407 — Parâmetros do validador factual (Marketing). Mesmo padrão do projeto: dicionário fail-closed em SETTINGS_SCHEMA
 * (settings.service.js faz o spread) + getSetting(chave, tenant, transaction, padrão). Padrão = Maturacao/demandas/parametros.csv.
 *  - tolerancia_area_m2 (MKT-P032): diferença aceita, em m², entre a área do texto e a do cadastro (padrão 0).
 *  - dicionario_features (MKT-P033): lista fechada de sinônimos, "característica: sinônimo, sinônimo; outra: ...". A característica
 *    precisa ser do catálogo de características permitidas (as únicas que o read model público traz).
 *  - telefones_empresa: telefones da empresa que o texto pode citar ("nenhum" = nenhum).
 */
const TOLERANCE_KEY = 'marketing.factual.tolerancia_area_m2';
const DICTIONARY_KEY = 'marketing.factual.dicionario_features';
const PHONES_KEY = 'marketing.factual.telefones_empresa';

const DEFAULT_DICTIONARY = [
  'piscina: piscinas',
  'churrasqueira: churrasqueiras',
  'varanda: varandas, sacada, sacadas',
  'elevador: elevadores',
  'academia: academias, sala de ginástica',
  'playground: playgrounds, parquinho',
  'salão de festas: salões de festas, salão de festa, espaço de festas',
  'portaria 24h: portaria 24 horas, portaria vinte e quatro horas',
  'ar-condicionado: ar condicionado, ares-condicionados',
  'mobiliado: mobiliada, mobilhado, mobilhada',
  'aceita pets: aceita animais, pet friendly, pet-friendly',
  'vaga coberta: vagas cobertas, garagem coberta',
].join('; ');

const FACTUAL_SETTING_DEFAULTS = Object.freeze({ [TOLERANCE_KEY]: 0, [DICTIONARY_KEY]: DEFAULT_DICTIONARY, [PHONES_KEY]: 'nenhum' });

const invalid = (key, message, extra) => AppError.badRequest(`O valor de "${key}" ${message}`, 'SETTING_INVALID_VALUE', { key, ...extra });

/** "a: x, y; b: z" -> Map(a -> [a, x, y], b -> [b, z]); lança 400 se o formato ou alguma característica estiver errado. */
function parseDictionary(text, key = DICTIONARY_KEY) {
  const groups = new Map();
  for (const chunk of String(text).split(';').map((c) => c.trim()).filter(Boolean)) {
    const [canonicalRaw, rest, ...extra] = chunk.split(':');
    const canonical = (canonicalRaw || '').trim().toLowerCase();
    if (extra.length > 0 || !canonical || rest === undefined) throw invalid(key, 'deve seguir o formato "característica: sinônimo, sinônimo; outra: sinônimo".', { chunk });
    if (!FEATURE_CATALOG.includes(canonical)) throw invalid(key, `tem característica desconhecida: ${canonical}.`, { unknown: canonical });
    const synonyms = rest.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    groups.set(canonical, [...new Set([canonical, ...synonyms])]);
  }
  if (groups.size === 0) throw invalid(key, 'deve ter ao menos uma característica.');
  return groups;
}

/** "(71) 3333-4444, 71 99999-0000" -> ['7133334444', '71999990000'] (só quem tem 8 dígitos ou mais). */
function parsePhones(text) {
  return String(text || '').split(/[,;]/).map((p) => p.replace(/\D/g, '')).filter((digits) => digits.length >= 8);
}

const FACTUAL_SETTINGS_SCHEMA = {
  [TOLERANCE_KEY]: { type: 'integer', min: 0, max: 1000 },
  [DICTIONARY_KEY]: { type: 'string', validate: (key, value) => { parseDictionary(value, key); } },
  [PHONES_KEY]: {
    type: 'string',
    validate: (key, value) => {
      const tokens = String(value).split(/[,;]/).map((t) => t.trim()).filter(Boolean);
      const bad = tokens.filter((t) => fold(t) !== 'nenhum' && t.replace(/\D/g, '').length < 8);
      if (bad.length > 0) throw invalid(key, 'tem telefone inválido (use DDD e número, ou "nenhum").', { bad });
    },
  },
};

/** Configuração vigente da empresa para o validador; valor guardado inválido volta ao padrão (nunca derruba o conteúdo). */
async function readFactualConfig(tenant, transaction) {
  const { getSetting } = require('../../../../features/settings/settings.service');
  const tolerance = Number(await getSetting(TOLERANCE_KEY, tenant, transaction, FACTUAL_SETTING_DEFAULTS[TOLERANCE_KEY]));
  const dictionaryText = await getSetting(DICTIONARY_KEY, tenant, transaction, DEFAULT_DICTIONARY);
  let featureGroups;
  try { featureGroups = parseDictionary(dictionaryText); } catch (err) { featureGroups = parseDictionary(DEFAULT_DICTIONARY); }
  return {
    toleranciaAreaM2: Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : FACTUAL_SETTING_DEFAULTS[TOLERANCE_KEY],
    featureGroups,
    telefonesEmpresa: parsePhones(await getSetting(PHONES_KEY, tenant, transaction, FACTUAL_SETTING_DEFAULTS[PHONES_KEY])),
  };
}

module.exports = {
  TOLERANCE_KEY, DICTIONARY_KEY, PHONES_KEY, DEFAULT_DICTIONARY, FACTUAL_SETTING_DEFAULTS, FACTUAL_SETTINGS_SCHEMA, parseDictionary, parsePhones, readFactualConfig,
};
