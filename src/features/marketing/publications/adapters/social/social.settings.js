'use strict';

const { mktError } = require('../../../marketing.errors');
const { SOCIAL_NETWORKS, FORMATS, DEFAULT_CAPABILITIES, deepFreeze } = require('./networks');
const { RATIO_RE } = require('./social.ratio');
const { MODES, DEFAULT_PREFIX } = require('./social.watermark');

/**
 * M9-D428 — parâmetros das redes sociais (aba Marketing de Configurações; padrão = Maturacao/demandas/parametros.csv). Lidos por getSetting a cada uso:
 *  - `marketing.social.<rede>.capacidades`: as capabilities da rede em JSON (formatos, proporções, duração máxima, tamanho máximo, limite de legenda);
 *  - `marketing.social.marca_idempotencia` (INVISIVEL ou HASHTAG), `marketing.social.hashtag_prefixo` e `marketing.social.tolerancia_proporcao_pct`.
 */
const capKey = (network) => `marketing.social.${network.toLowerCase()}.capacidades`;
const KEYS = Object.freeze({ mark: 'marketing.social.marca_idempotencia', prefix: 'marketing.social.hashtag_prefixo', tolerance: 'marketing.social.tolerancia_proporcao_pct' });

const SOCIAL_SETTING_DEFAULTS = Object.freeze({
  [KEYS.mark]: 'INVISIVEL', [KEYS.prefix]: DEFAULT_PREFIX, [KEYS.tolerance]: 2,
  ...Object.fromEntries(SOCIAL_NETWORKS.map((n) => [capKey(n), JSON.stringify(DEFAULT_CAPABILITIES[n])])),
});

const invalid = (key, expected) => mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: expected });
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const positiveInt = (v) => Number.isInteger(v) && v > 0 && v <= 10 ** 9;

/** Estrutura das capabilities; devolve a mensagem do problema ou null. */
function problemOf(caps) {
  if (!isPlain(caps)) return 'um objeto JSON';
  if (!Array.isArray(caps.formatos) || caps.formatos.length === 0 || !caps.formatos.every((f) => FORMATS.includes(f))) return `"formatos": lista de ${FORMATS.join(', ')}`;
  if (!positiveInt(caps.legendaMax) || caps.legendaMax > 1000000) return '"legendaMax": inteiro de 1 a 1000000';
  if (!isPlain(caps.proporcoes) || !Object.keys(caps.proporcoes).length) return '"proporcoes": objeto formato -> lista de proporções (ex.: "9:16")';
  for (const [format, list] of Object.entries(caps.proporcoes)) {
    if (!FORMATS.includes(format) || !Array.isArray(list) || !list.length || !list.every((r) => typeof r === 'string' && RATIO_RE.test(r))) return `"proporcoes.${format}": lista de proporções largura:altura`;
  }
  for (const field of ['duracaoMaxS', 'tamanhoMaxMb']) {
    if (caps[field] === undefined) continue;
    if (!isPlain(caps[field]) || !Object.entries(caps[field]).every(([f, v]) => FORMATS.includes(f) && positiveInt(v))) return `"${field}": objeto formato -> inteiro positivo`;
  }
  return null;
}

function validateCaps(key, value) {
  let parsed = null;
  try { parsed = JSON.parse(value); } catch { throw invalid(key, 'JSON válido com formatos, proporcoes, duracaoMaxS, tamanhoMaxMb e legendaMax'); }
  const problem = problemOf(parsed);
  if (problem) throw invalid(key, problem);
}

function validateMark(key, value) {
  if (!MODES.includes(String(value).trim())) throw invalid(key, MODES.join(' ou '));
}
function validatePrefix(key, value) {
  if (!/^[a-z0-9]{2,12}$/.test(String(value).trim())) throw invalid(key, 'de 2 a 12 letras minúsculas ou números');
}

const SOCIAL_SETTINGS_SCHEMA = {
  [KEYS.mark]: { type: 'string', validate: validateMark },
  [KEYS.prefix]: { type: 'string', validate: validatePrefix },
  [KEYS.tolerance]: { type: 'integer', min: 0, max: 20 },
  ...Object.fromEntries(SOCIAL_NETWORKS.map((n) => [capKey(n), { type: 'string', validate: validateCaps }])),
};

const getSetting = (...args) => require('../../../../settings/settings.service').getSetting(...args); // leitura tardia: o dicionário de parâmetros carrega este arquivo

function parseCaps(text, network) {
  try {
    const parsed = JSON.parse(text);
    return problemOf(parsed) ? DEFAULT_CAPABILITIES[network] : deepFreeze(parsed);
  } catch { return DEFAULT_CAPABILITIES[network]; }
}

/** Configuração das redes da empresa, lida na hora: { capabilities: { REDE: caps }, mark, prefix, tolerancePct }. Valor estranho volta ao padrão. */
async function readSocialConfig(tenant, transaction) {
  const capabilities = {};
  for (const network of SOCIAL_NETWORKS) {
    capabilities[network] = parseCaps(String(await getSetting(capKey(network), tenant, transaction, SOCIAL_SETTING_DEFAULTS[capKey(network)])), network);
  }
  const mark = String(await getSetting(KEYS.mark, tenant, transaction, SOCIAL_SETTING_DEFAULTS[KEYS.mark])).trim();
  const prefix = String(await getSetting(KEYS.prefix, tenant, transaction, SOCIAL_SETTING_DEFAULTS[KEYS.prefix])).trim();
  const tolerance = Number(await getSetting(KEYS.tolerance, tenant, transaction, SOCIAL_SETTING_DEFAULTS[KEYS.tolerance]));
  return {
    capabilities,
    mark: MODES.includes(mark) ? mark : SOCIAL_SETTING_DEFAULTS[KEYS.mark],
    prefix: /^[a-z0-9]{2,12}$/.test(prefix) ? prefix : DEFAULT_PREFIX,
    tolerancePct: Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : SOCIAL_SETTING_DEFAULTS[KEYS.tolerance],
  };
}

/** Opções que o adapter da rede recebe na construção. */
const adapterOptions = (network, config) => ({ networkCaps: config.capabilities[network], watermarkMode: config.mark, hashtagPrefix: config.prefix, tolerancePct: config.tolerancePct });

module.exports = { capKey, KEYS, SOCIAL_SETTING_DEFAULTS, SOCIAL_SETTINGS_SCHEMA, readSocialConfig, adapterOptions };
