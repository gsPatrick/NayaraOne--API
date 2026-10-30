'use strict';

const { mktError } = require('../../marketing.errors');

/**
 * M9-D427 regra 5 — parâmetros do blog educativo (EDUCATIONAL_BLOG). Mesmo padrão do projeto: dicionário fail-closed em SETTINGS_SCHEMA
 * (settings.service.js faz o spread de BLOG_SETTINGS_SCHEMA) + getSetting. Padrões de Maturacao/demandas/parametros.csv (MKT-P049, MKT-P050).
 *  - fontes_permitidas: domínios aceitos como fonte (padrão: gov.br, ibge.gov.br, bcb.gov.br, caixa.gov.br, cnj.jus.br). Lista vazia = nenhuma
 *    fonte, logo nenhum blog passa: é recusada na escrita (422 MKT_PARAM_INVALID).
 *  - dominios_empresa: domínios da própria empresa, que também valem como fonte (DI-D427-3; "nenhum" = nenhum).
 *  - min_palavras: mínimo de palavras do artigo (padrão 400).
 *  - aviso_ia: frase do aviso de apoio de inteligência artificial (M9-D426 item 4), exigida no artigo gerado pela NAY (DI-D427-4).
 */
const SOURCES_KEY = 'marketing.blog.fontes_permitidas';
const OWN_DOMAINS_KEY = 'marketing.blog.dominios_empresa';
const MIN_WORDS_KEY = 'marketing.blog.min_palavras';
const AI_NOTICE_KEY = 'marketing.blog.aviso_ia';
const NONE = 'nenhum';

const BLOG_SETTING_DEFAULTS = Object.freeze({
  [SOURCES_KEY]: 'gov.br, ibge.gov.br, bcb.gov.br, caixa.gov.br, cnj.jus.br',
  [OWN_DOMAINS_KEY]: NONE,
  [MIN_WORDS_KEY]: 400,
  [AI_NOTICE_KEY]: 'Conteúdo gerado com apoio de inteligência artificial',
});

// settings.service.js importa este arquivo (SETTINGS_SCHEMA): a leitura é carregada na hora do uso, para não fechar um ciclo.
const getSetting = (...args) => require('../../../settings/settings.service').getSetting(...args);

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** "gov.br, IBGE.gov.br" -> ['gov.br','ibge.gov.br'] (minúsculas, sem vazios nem repetidos; "nenhum" = lista vazia). */
function parseDomains(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  if (!raw || raw.toLowerCase() === NONE) return [];
  return [...new Set(raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean))];
}

function validateDomains({ allowNone }) {
  return (key, value) => {
    const list = parseDomains(value);
    const bad = list.filter((d) => !DOMAIN_RE.test(d));
    if ((list.length === 0 && !allowNone) || bad.length > 0) {
      throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', {
        key, esperado: allowNone ? 'domínios separados por vírgula (ex.: gov.br, suaempresa.com.br) ou "nenhum"' : 'ao menos um domínio, separados por vírgula (ex.: gov.br, ibge.gov.br); lista vazia deixaria o blog sem nenhuma fonte válida', invalidos: bad,
      });
    }
  };
}

const BLOG_SETTINGS_SCHEMA = {
  [SOURCES_KEY]: { type: 'string', validate: validateDomains({ allowNone: false }) },
  [OWN_DOMAINS_KEY]: { type: 'string', validate: validateDomains({ allowNone: true }) },
  [MIN_WORDS_KEY]: { type: 'integer', min: 1, max: 20000 },
  [AI_NOTICE_KEY]: { type: 'string', validate: (key, value) => { if (String(value).trim().length < 10 || String(value).length > 200) throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: 'frase de 10 a 200 caracteres' }); } },
};

/** { allowedDomains, minWords, aiNotice } da empresa, já saneados (valor estranho volta ao padrão). */
async function readBlogConfig(tenant, transaction) {
  const [sources, own, minWords, notice] = await Promise.all([
    getSetting(SOURCES_KEY, tenant, transaction, BLOG_SETTING_DEFAULTS[SOURCES_KEY]),
    getSetting(OWN_DOMAINS_KEY, tenant, transaction, BLOG_SETTING_DEFAULTS[OWN_DOMAINS_KEY]),
    getSetting(MIN_WORDS_KEY, tenant, transaction, BLOG_SETTING_DEFAULTS[MIN_WORDS_KEY]),
    getSetting(AI_NOTICE_KEY, tenant, transaction, BLOG_SETTING_DEFAULTS[AI_NOTICE_KEY]),
  ]);
  const words = Number(minWords);
  const sourceDomains = parseDomains(sources).filter((d) => DOMAIN_RE.test(d));
  return {
    allowedDomains: [...new Set([...(sourceDomains.length ? sourceDomains : parseDomains(BLOG_SETTING_DEFAULTS[SOURCES_KEY])), ...parseDomains(own).filter((d) => DOMAIN_RE.test(d))])],
    minWords: Number.isInteger(words) && words >= 1 ? words : BLOG_SETTING_DEFAULTS[MIN_WORDS_KEY],
    aiNotice: String(notice).trim() || BLOG_SETTING_DEFAULTS[AI_NOTICE_KEY],
  };
}

module.exports = { SOURCES_KEY, OWN_DOMAINS_KEY, MIN_WORDS_KEY, AI_NOTICE_KEY, BLOG_SETTING_DEFAULTS, BLOG_SETTINGS_SCHEMA, parseDomains, readBlogConfig };
