'use strict';

const { mktError } = require('../../marketing.errors');

/**
 * M9-D426 — parâmetros do vídeo e da mídia do Marketing (aba Marketing de Configurações; padrão = Maturacao/demandas/parametros.csv). Lidos por getSetting a cada uso:
 *  - política de transparência (livro: aviso sempre que sintético) e, na política POR_TIPO, os tipos de elemento sintético que exigem aviso;
 *  - os três textos padrão (aviso de IA, aviso de imagem de projeto e a expressão "Imagem ilustrativa" que a renderização de obra precisa carregar);
 *  - as origens de mídia aceitas na autorização e o máximo de mídias de uma montagem.
 */
const KEYS = Object.freeze({
  policy: 'marketing.video.politica_transparencia',
  kinds: 'marketing.video.tipos_com_aviso',
  noticeAi: 'marketing.video.aviso_ia',
  noticeProject: 'marketing.video.aviso_projeto',
  phrase: 'marketing.video.texto_ilustrativa',
  origins: 'marketing.video.origens_midia',
  maxMedia: 'marketing.video.max_midias',
});

const POLICIES = Object.freeze(['SEMPRE', 'POR_TIPO']);
const SYNTHETIC_KINDS = Object.freeze(['VOICE', 'AVATAR', 'SCENE', 'RENDER', 'ILLUSTRATION']);

const VIDEO_SETTING_DEFAULTS = Object.freeze({
  [KEYS.policy]: 'SEMPRE',
  [KEYS.kinds]: SYNTHETIC_KINDS.join(','),
  [KEYS.noticeAi]: 'Conteúdo gerado com apoio de inteligência artificial',
  [KEYS.noticeProject]: 'Imagens ilustrativas de projeto',
  [KEYS.phrase]: 'Imagem ilustrativa',
  [KEYS.origins]: 'EQUIPE,OBRA,CORRETOR,BANCO_LICENCIADO,RENDER_PROJETO',
  [KEYS.maxMedia]: 30,
});

const invalid = (key, expected) => mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: expected });
const parseCsv = (text) => [...new Set(String(text || '').split(',').map((p) => p.trim().toUpperCase()).filter(Boolean))];

function validatePolicy(key, value) {
  if (!POLICIES.includes(String(value).trim())) throw invalid(key, POLICIES.join(' ou '));
}
function validateKinds(key, value) {
  const list = parseCsv(value);
  if (list.length === 0 || list.some((k) => !SYNTHETIC_KINDS.includes(k))) throw invalid(key, `lista de ${SYNTHETIC_KINDS.join(', ')}`);
}
function validateOrigins(key, value) {
  const list = parseCsv(value);
  if (list.length === 0 || list.length > 20 || list.some((o) => !/^[A-Z][A-Z0-9_]{1,39}$/.test(o))) throw invalid(key, 'lista de códigos em maiúsculas separados por vírgula (ex.: EQUIPE,OBRA)');
}
function validateText(key, value) {
  const text = String(value).trim();
  if (text.length < 3 || text.length > 200) throw invalid(key, 'texto de 3 a 200 caracteres');
}

const VIDEO_SETTINGS_SCHEMA = {
  [KEYS.policy]: { type: 'string', validate: validatePolicy },
  [KEYS.kinds]: { type: 'string', validate: validateKinds },
  [KEYS.noticeAi]: { type: 'string', validate: validateText },
  [KEYS.noticeProject]: { type: 'string', validate: validateText },
  [KEYS.phrase]: { type: 'string', validate: validateText },
  [KEYS.origins]: { type: 'string', validate: validateOrigins },
  [KEYS.maxMedia]: { type: 'integer', min: 1, max: 200 },
};

const getSetting = (...args) => require('../../../settings/settings.service').getSetting(...args); // leitura tardia: o dicionário de parâmetros carrega este arquivo

async function readText(key, tenant, transaction) {
  const value = String(await getSetting(key, tenant, transaction, VIDEO_SETTING_DEFAULTS[key])).trim();
  return value || VIDEO_SETTING_DEFAULTS[key];
}

/** Configuração do vídeo da empresa, lida na hora (valor estranho volta ao padrão: nunca decide por valor inválido). */
async function readVideoConfig(tenant, transaction) {
  const policyRaw = String(await getSetting(KEYS.policy, tenant, transaction, VIDEO_SETTING_DEFAULTS[KEYS.policy])).trim();
  const kinds = parseCsv(await getSetting(KEYS.kinds, tenant, transaction, VIDEO_SETTING_DEFAULTS[KEYS.kinds])).filter((k) => SYNTHETIC_KINDS.includes(k));
  const origins = parseCsv(await getSetting(KEYS.origins, tenant, transaction, VIDEO_SETTING_DEFAULTS[KEYS.origins]));
  const max = Number(await getSetting(KEYS.maxMedia, tenant, transaction, VIDEO_SETTING_DEFAULTS[KEYS.maxMedia]));
  return {
    policy: POLICIES.includes(policyRaw) ? policyRaw : 'SEMPRE',
    noticeKinds: kinds.length ? kinds : [...SYNTHETIC_KINDS],
    noticeAi: await readText(KEYS.noticeAi, tenant, transaction),
    noticeProject: await readText(KEYS.noticeProject, tenant, transaction),
    phrase: await readText(KEYS.phrase, tenant, transaction),
    origins: origins.length ? origins : parseCsv(VIDEO_SETTING_DEFAULTS[KEYS.origins]),
    maxMedia: Number.isInteger(max) && max >= 1 ? max : VIDEO_SETTING_DEFAULTS[KEYS.maxMedia],
  };
}

module.exports = { KEYS, POLICIES, SYNTHETIC_KINDS, VIDEO_SETTING_DEFAULTS, VIDEO_SETTINGS_SCHEMA, readVideoConfig, parseCsv };
